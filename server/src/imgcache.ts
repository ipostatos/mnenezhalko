/**
 * Image pipeline для обложек. Большинство книг ссылаются на чужие хосты (livelib,
 * amazon, польские CDN, image-прокси Notion): оригиналы весят по 2-3 МБ, грузятся
 * медленно и с десятка доменов. Проксируем через себя И приводим к превью нужной
 * ширины (webp) — не кэш оригиналов, а полноценный конвейер:
 *   1) тянем с origin один раз (с лимитом одновременных загрузок — карусель на
 *      холодном кэше просит десятки сразу, нельзя бомбить внешние сайты и рвать сеть);
 *   2) ресайзим до целевой ширины и жмём в webp (обычно 2-3 МБ → 20-40 КБ);
 *   3) кладём вариант на диск (ключ = url+ширина), дальше отдаём с immutable-кэшем.
 *
 * Ссылки подписываем HMAC (подпись покрывает и ширину) — чтобы `/api/img` не стал
 * открытым прокси/ресайзером (SSRF): обслуживаем только свои же сгенерированные url.
 */
import { createHash, createHmac } from 'node:crypto'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { env } from './env.js'
import { assertPublicUrl } from './net.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = path.resolve(here, '../data/imgcache')

const MAX_BYTES = 8 * 1024 * 1024
const TIMEOUT_MS = 8000
const MAX_CONCURRENT = 4

/**
 * Реальные размеры отрисовки обложки в Mini App (см. web/src/styles.css):
 * список (.cover, 44×62 CSS) и карусель (.cc-item, 156×234 CSS) — самые частые;
 * увеличенный вид (.cover.lg 104×148, .edit-cover 128×180) — редкий. Ширина —
 * ×2 от CSS-пикселей (ретина) с небольшим запасом, не больше. Отдельного
 * «полноразмерного» варианта нет: нигде в интерфейсе обложка крупнее 128px не
 * показывается, заводить его сейчас незачем.
 */
export const LIST_W = 96 // строки списков: поиск, полка, история/список выдач
export const CARD_W = 220 // разворот книги и экран правки на «Моей полке»
export const CAROUSEL_W = 320 // карусель обложек (156px CSS ×2)

const sign = (url: string, w: number) =>
  createHmac('sha256', env.webhookSecret).update(`img:${w}:${url}`).digest('hex').slice(0, 16)

/**
 * Внешнюю обложку заменяем на ссылку через наш конвейер с целевой шириной `w`;
 * свои (/api/cover) и data: оставляем как есть.
 */
export function proxyCover(url: string | null, w = LIST_W): string | null {
  if (!url) return null
  if (url.startsWith('data:')) return url
  if (url.includes('/api/cover/') || url.includes('/api/img')) return url
  if (/^https?:\/\//.test(url))
    return `/api/img?u=${encodeURIComponent(url)}&w=${w}&s=${sign(url, w)}`
  return url
}

const keyOf = (url: string, w: number) => createHash('sha1').update(`${w}:${url}`).digest('hex')

// Ограничитель одновременных внешних загрузок: холодный кэш карусели = десятки
// запросов разом, иначе сервер открывает столько же соединений к чужим хостам.
let active = 0
const waiters: Array<() => void> = []
async function acquire() {
  if (active < MAX_CONCURRENT) {
    active++
    return
  }
  await new Promise<void>((resolve) => waiters.push(resolve))
  active++
}
function release() {
  active--
  waiters.shift()?.()
}

// Дедуп одинаковых (url,w), пока идёт загрузка: два запроса на одну обложку
// делят одну внешнюю загрузку, а не тянут дважды.
const inflight = new Map<string, Promise<{ body: Buffer; type: string } | null>>()

// Негативный кэш: у битой/недоступной обложки не долбим origin на каждый заход.
const NEG_TTL_MS = 60 * 60 * 1000 // 1 час
const negative = new Map<string, number>() // ключ → до какого времени не пробовать

/**
 * Fetch с ручной обработкой редиректов и SSRF-проверкой на КАЖДОМ hop:
 * публичный домен не должен увести нас на приватный адрес редиректом.
 */
async function safeFetch(url: string, signal: AbortSignal): Promise<Response | null> {
  let current = url
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicUrl(current) // бросит на приватном/битом — поймается выше
    const res = await fetch(current, {
      signal,
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; mnenezhalko)' },
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return res
      current = new URL(loc, current).toString()
      continue
    }
    return res
  }
  return null // слишком много редиректов
}

/**
 * Читает тело ответа с обрывом по факту превышения лимита, а не после того,
 * как всё уже скачано в память: `Content-Length` проверяем сразу (если origin
 * его прислал), а дальше считаем байты по мере чтения стрима и обрываем
 * соединение (`ctrl.abort()`), как только вышли за лимит — origin, который
 * присылает гигабайты без Content-Length, не должен упасть в память процесса
 * целиком, прежде чем мы это заметим.
 */
async function readLimited(res: Response, ctrl: AbortController): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > MAX_BYTES) return null
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length > MAX_BYTES ? null : buf
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BYTES) {
        ctrl.abort()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

async function fetchAndResize(
  url: string,
  w: number,
): Promise<{ body: Buffer; type: string } | null> {
  await acquire()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await safeFetch(url, ctrl.signal)
    if (!res || !res.ok) return null
    const type = res.headers.get('content-type') || 'image/jpeg'
    if (!type.startsWith('image/')) return null
    const orig = await readLimited(res, ctrl)
    if (!orig || !orig.length) return null
    // Ресайз в webp-превью; если sharp не осилил (SVG/битый) — отдаём оригинал.
    try {
      const body = await sharp(orig, { failOn: 'none' })
        .rotate() // авто-поворот по EXIF
        .resize({ width: w, withoutEnlargement: true })
        .webp({ quality: 78 })
        .toBuffer()
      return { body, type: 'image/webp' }
    } catch {
      return { body: orig, type }
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    release()
  }
}

/**
 * Прогрев витрины: как только формируется новая подборка карусели (см.
 * showcaseCache в routes.ts), заранее тянем и кэшируем превью, а не заставляем
 * первого посетителя за после-ротации оплачивать все 12 MISS разом. Не
 * блокирует ответ `/api/showcase` (вызывающий код не ждёт этот промис), не
 * ретраит бесконечно — при неудаче `cachedImage` сам пишет негативный кэш,
 * повторную попытку запустит только следующая ротация показа.
 */
export function warmShowcaseCovers(urls: (string | null)[], w = CAROUSEL_W): void {
  for (const url of urls) {
    if (!url || !/^https?:\/\//.test(url)) continue
    void cachedImage(url, w, sign(url, w)).catch(() => {})
  }
}

/**
 * Отдаёт превью обложки шириной `w` по внешнему url (с проверкой подписи).
 * Сначала с диска, при промахе — тянет с origin, ресайзит и кэширует.
 * null — если подпись не сошлась или не вышло.
 */
export type CachedImage = { body: Buffer; type: string; cache: 'HIT' | 'MISS' }

export async function cachedImage(
  url: string,
  w: number,
  sig: string,
): Promise<CachedImage | null> {
  if (!/^https?:\/\//.test(url) || sign(url, w) !== sig) return null
  await mkdir(CACHE_DIR, { recursive: true })
  const base = path.join(CACHE_DIR, keyOf(url, w))

  try {
    const [body, type] = await Promise.all([readFile(base), readFile(`${base}.type`, 'utf8')])
    return { body, type, cache: 'HIT' }
  } catch {
    /* промах кэша — тянем ниже */
  }

  // недавно не смогли загрузить — не бьём origin снова (негативный кэш)
  const negUntil = negative.get(base)
  if (negUntil && negUntil > Date.now()) return null

  let p = inflight.get(base)
  if (!p) {
    p = fetchAndResize(url, w)
      .then(async (r) => {
        if (r) {
          negative.delete(base)
          await Promise.all([
            writeFile(base, r.body),
            writeFile(`${base}.type`, r.type),
          ]).catch(() => {})
        } else {
          negative.set(base, Date.now() + NEG_TTL_MS)
        }
        return r
      })
      .finally(() => inflight.delete(base))
    inflight.set(base, p)
  }
  const r = await p
  return r ? { ...r, cache: 'MISS' } : null
}

/**
 * Housekeeping диска: без него `imgcache` растёт бесконечно — файлы пишутся
 * при каждом MISS и никогда не удаляются (на 25 июля 2026 это уже 181 МБ,
 * см. docs/PERFORMANCE_BASELINE.md). Оригинал всегда можно перекачать заново,
 * так что превью — не более чем кэш: старое и лишнее по объёму можно спокойно
 * стирать, следующий запрос просто ещё раз пройдёт через MISS.
 */
export const CACHE_MAX_AGE_MS = 60 * 24 * 3600_000 // 60 дней без перезаписи — книга давно не в витрине/поиске
export const CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024 // 2 ГБ — жёсткий потолок диска под превью
// не трогаем файлы младше этого возраста: readdir мог застать файл в процессе
// записи (writeFile не атомарный через temp+rename), а не только что дописанный
// точно не претендент на удаление по возрасту/объёму
export const HOUSEKEEP_MIN_FILE_AGE_MS = 5 * 60_000

type CacheEntry = { path: string; typePath: string; mtime: number; size: number }

async function scanCacheEntries(dir: string): Promise<CacheEntry[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const entries: CacheEntry[] = []
  for (const name of names) {
    if (name.endsWith('.type')) continue // сайдкар подхватываем вместе с базовым файлом
    const full = path.join(dir, name)
    const st = await stat(full).catch(() => null)
    if (!st || !st.isFile()) continue
    entries.push({ path: full, typePath: `${full}.type`, mtime: st.mtimeMs, size: st.size })
  }
  return entries
}

/** `dir`/`maxBytes` — переопределяются в тестах, чтобы не трогать реальный диск и лимит в 2 ГБ. */
export async function housekeepImgCache(
  now = Date.now(),
  dir = CACHE_DIR,
  maxBytes = CACHE_MAX_BYTES,
): Promise<{ scanned: number; removed: number; freedBytes: number }> {
  const entries = await scanCacheEntries(dir)
  let removed = 0
  let freedBytes = 0

  const remove = async (e: CacheEntry) => {
    const [a, b] = await Promise.allSettled([unlink(e.path), unlink(e.typePath)])
    // freedBytes считаем, только если базовый файл реально стёрт — иначе задвоим счётчик
    if (a.status === 'fulfilled') {
      removed++
      freedBytes += e.size
    }
    void b
  }

  const survivors: CacheEntry[] = []
  for (const e of entries) {
    const age = now - e.mtime
    if (age < HOUSEKEEP_MIN_FILE_AGE_MS) {
      survivors.push(e) // слишком свежий — не рискуем задеть незавершённую запись
      continue
    }
    if (age > CACHE_MAX_AGE_MS) {
      await remove(e)
      continue
    }
    survivors.push(e)
  }

  let total = survivors.reduce((s, e) => s + e.size, 0)
  if (total > maxBytes) {
    // старейшие по mtime — первые кандидаты, in-flight-запись не тронем (см. выше)
    survivors.sort((a, b) => a.mtime - b.mtime)
    for (const e of survivors) {
      if (total <= maxBytes) break
      if (now - e.mtime < HOUSEKEEP_MIN_FILE_AGE_MS) continue
      await remove(e)
      total -= e.size
    }
  }

  return { scanned: entries.length, removed, freedBytes }
}
