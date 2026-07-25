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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { env } from './env.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = path.resolve(here, '../data/imgcache')

const MAX_BYTES = 8 * 1024 * 1024
const TIMEOUT_MS = 8000
const DEFAULT_W = 640 // карточки/детали; карусель просит 320 явно
const MAX_CONCURRENT = 4

const sign = (url: string, w: number) =>
  createHmac('sha256', env.webhookSecret).update(`img:${w}:${url}`).digest('hex').slice(0, 16)

/**
 * Внешнюю обложку заменяем на ссылку через наш конвейер с целевой шириной `w`;
 * свои (/api/cover) и data: оставляем как есть.
 */
export function proxyCover(url: string | null, w = DEFAULT_W): string | null {
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

async function fetchAndResize(
  url: string,
  w: number,
): Promise<{ body: Buffer; type: string } | null> {
  await acquire()
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; mnenezhalko)' },
    }).finally(() => clearTimeout(timer))
    if (!res.ok) return null
    const type = res.headers.get('content-type') || 'image/jpeg'
    if (!type.startsWith('image/')) return null
    const orig = Buffer.from(await res.arrayBuffer())
    if (!orig.length || orig.length > MAX_BYTES) return null
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
    release()
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
