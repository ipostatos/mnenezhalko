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
import { Agent, fetch as undiciFetch } from 'undici'
import { env } from './env.js'
import { assertPublicUrl, type ResolvedAddr } from './net.js'

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
 * Агент undici, подключение которого «пришпилено» к уже проверенным адресам —
 * а не резолвит хост заново. Без этого проверка (assertPublicUrl) и реальное
 * соединение (fetch) были бы двумя НЕЗАВИСИМЫМИ DNS-резолвами: атакующий DNS
 * с TTL=0 мог бы ответить публичным адресом на первый (проверочный) запрос и
 * приватным — на второй (для соединения), и SSRF-проверка ничего бы не решала
 * (классический DNS rebinding). Одноразовый на один hop — держать пул незачем,
 * keepAlive выключен, чтобы сокет не завис в пуле дольше самого запроса.
 */
function pinnedAgent(addrs: ResolvedAddr[]): Agent {
  return new Agent({
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
    connect: {
      lookup: (_hostname: string, options: any, callback: any) => {
        if (options?.all) callback(null, addrs)
        else callback(null, addrs[0].address, addrs[0].family)
      },
    },
  })
}

/** Один hop: подключение к уже проверенным адресам. Подменяется в тестах редиректов. */
export type HopFetch = (url: string, addrs: ResolvedAddr[], signal: AbortSignal) => Promise<Response>

const realHopFetch: HopFetch = (url, addrs, signal) =>
  undiciFetch(url, {
    signal,
    redirect: 'manual',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; mnenezhalko)' },
    dispatcher: pinnedAgent(addrs),
  }) as unknown as Promise<Response>

/**
 * Fetch с ручной обработкой редиректов и SSRF-проверкой на КАЖДОМ hop:
 * публичный домен не должен увести нас на приватный адрес редиректом.
 */
export async function safeFetch(
  url: string,
  signal: AbortSignal,
  hopFetch: HopFetch = realHopFetch,
): Promise<Response | null> {
  let current = url
  for (let hop = 0; hop < 4; hop++) {
    // бросит на приватном/битом; возвращает проверенные адреса — подключаемся
    // именно к ним (см. pinnedAgent), а не резолвим current заново
    const addrs = await assertPublicUrl(current)
    const res = await hopFetch(current, addrs, signal)
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
async function readLimited(res: Response, ctrl: AbortController): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > MAX_BYTES) throw new Error('too_large')
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new Error('too_large')
    return buf
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
        throw new Error('too_large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

/** Категория неудачи origin-запроса — для метрик/логов, не для текста ответа клиенту. */
export type ImgErrorCategory =
  | 'private_host' // SSRF-фильтр (net.ts): приватный/зарезервированный адрес или редирект на такой
  | 'too_many_redirects'
  | 'http_error' // origin ответил не 2xx
  | 'bad_content_type' // Content-Type не image/*
  | 'too_large' // Content-Length или фактический размер > MAX_BYTES
  | 'empty' // тело пустое
  | 'timeout' // не уложились в TIMEOUT_MS
  | 'network' // сеть/DNS/прочее

type FetchOutcome =
  | { ok: true; body: Buffer; type: string; inputBytes: number; resizeMs: number }
  | { ok: false; category: ImgErrorCategory }

async function fetchAndResize(url: string, w: number): Promise<FetchOutcome> {
  await acquire()
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, TIMEOUT_MS)
  try {
    const res = await safeFetch(url, ctrl.signal)
    if (!res) return { ok: false, category: 'too_many_redirects' }
    if (!res.ok) return { ok: false, category: 'http_error' }
    const type = res.headers.get('content-type') || 'image/jpeg'
    if (!type.startsWith('image/')) return { ok: false, category: 'bad_content_type' }
    const orig = await readLimited(res, ctrl)
    if (!orig.length) return { ok: false, category: 'empty' }
    const t1 = Date.now()
    // Ресайз в webp-превью; если sharp не осилил (SVG/битый) — отдаём оригинал.
    try {
      const body = await sharp(orig, { failOn: 'none' })
        .rotate() // авто-поворот по EXIF
        .resize({ width: w, withoutEnlargement: true })
        .webp({ quality: 78 })
        .toBuffer()
      return { ok: true, body, type: 'image/webp', inputBytes: orig.length, resizeMs: Date.now() - t1 }
    } catch {
      return { ok: true, body: orig, type, inputBytes: orig.length, resizeMs: Date.now() - t1 }
    }
  } catch (e) {
    const msg = String((e as Error)?.message || '')
    if (msg === 'too_large') return { ok: false, category: 'too_large' }
    if (msg === 'private_host' || msg === 'bad_url' || msg === 'bad_scheme' || msg === 'no_dns')
      return { ok: false, category: 'private_host' }
    return { ok: false, category: timedOut ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
    release()
  }
}

/**
 * Метрики image pipeline — без стороннего monitoring-стека (см. `/api/admin/img-metrics`
 * в routes.ts, только для админа): счётчики HIT/MISS/NEGATIVE, bucketed-длительность
 * (не средняя — редкий очень медленный запрос иначе прячется в среднем) и разбивка
 * origin-неудач по категории. Живут в памяти процесса, обнуляются рестартом — этого
 * достаточно для проекта такого размера, отдельное хранилище было бы overkill.
 */
const DURATION_BUCKETS_MS = [10, 50, 200, 500, 2000] // последний «бакет» — «свыше 2000»
const counters = { hit: 0, miss: 0, negative: 0 }
const durationBuckets = new Array(DURATION_BUCKETS_MS.length + 1).fill(0)
const originFailures = new Map<ImgErrorCategory, number>()

function bucketOf(ms: number): number {
  for (let i = 0; i < DURATION_BUCKETS_MS.length; i++) if (ms < DURATION_BUCKETS_MS[i]) return i
  return DURATION_BUCKETS_MS.length
}

function recordDuration(ms: number): void {
  durationBuckets[bucketOf(ms)]++
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** Снимок метрик — для админской ручки. Диск сканируем по запросу, не держим бегущий счётчик. */
export async function imgPipelineMetrics() {
  const disk = await scanCacheEntries(CACHE_DIR)
  return {
    hit: counters.hit,
    miss: counters.miss,
    negative: counters.negative,
    durationBuckets: [...DURATION_BUCKETS_MS, null].map((under, i) => ({
      under_ms: under,
      count: durationBuckets[i],
    })),
    originFailures: Object.fromEntries(originFailures),
    cacheFiles: disk.length,
    cacheBytes: disk.reduce((s, e) => s + e.size, 0),
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
 *
 * Три разных «не смог» специально не схлопнуты в одно `null`, чтобы
 * `/api/img` мог честно отдать `X-Image-Cache: NEGATIVE` (уже знаем, что
 * обложка недоступна, origin не трогали) отдельно от `MISS`, который в итоге
 * тоже не вышел (origin спросили прямо сейчас, и это тоже провалилось) —
 * иначе оба выглядели бы одинаково в метриках, хотя по нагрузке на origin
 * это разные вещи. `null` — отдельно, это невалидный запрос (не сошлась
 * подпись/url), а не состояние кэша вовсе.
 */
export type CachedImage =
  | { body: Buffer; type: string; cache: 'HIT' | 'MISS' }
  | { cache: 'NEGATIVE' }

export async function cachedImage(
  url: string,
  w: number,
  sig: string,
): Promise<CachedImage | null> {
  if (!/^https?:\/\//.test(url) || sign(url, w) !== sig) return null
  await mkdir(CACHE_DIR, { recursive: true })
  const base = path.join(CACHE_DIR, keyOf(url, w))
  const host = safeHostname(url)

  try {
    const [body, type] = await Promise.all([readFile(base), readFile(`${base}.type`, 'utf8')])
    counters.hit++
    return { body, type, cache: 'HIT' }
  } catch {
    /* промах кэша — тянем ниже */
  }

  // недавно не смогли загрузить — не бьём origin снова (негативный кэш)
  const negUntil = negative.get(base)
  if (negUntil && negUntil > Date.now()) {
    counters.negative++
    return { cache: 'NEGATIVE' }
  }

  let p = inflight.get(base)
  if (!p) {
    const t0 = Date.now()
    p = fetchAndResize(url, w)
      .then(async (r) => {
        const dur = Date.now() - t0
        recordDuration(dur)
        if (r.ok) {
          negative.delete(base)
          await Promise.all([
            writeFile(base, r.body),
            writeFile(`${base}.type`, r.type),
          ]).catch(() => {})
          console.log(
            `[img] MISS ok host=${host} w=${w} in=${r.inputBytes}B out=${r.body.length}B resize=${r.resizeMs}ms total=${dur}ms`,
          )
          return { body: r.body, type: r.type }
        }
        negative.set(base, Date.now() + NEG_TTL_MS)
        originFailures.set(r.category, (originFailures.get(r.category) ?? 0) + 1)
        // без полного url — он может нести query-токены чужого сервиса; хостом достаточно
        console.log(`[img] fail host=${host} w=${w} category=${r.category} total=${dur}ms`)
        return null
      })
      .finally(() => inflight.delete(base))
    inflight.set(base, p)
  }
  const r = await p
  if (r) {
    counters.miss++
    return { ...r, cache: 'MISS' }
  }
  counters.negative++
  return { cache: 'NEGATIVE' }
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
