/**
 * Кэш внешних обложек. Большинство книг ссылаются на чужие хосты (livelib,
 * amazon, польские CDN, image-прокси Notion) — грузятся медленно и по одной.
 * Проксируем через себя: первый раз тянем с origin и кладём на диск, дальше
 * отдаём с диска с immutable-заголовками (браузер тоже закэширует).
 *
 * Ссылки подписываем HMAC — чтобы `/api/img` не стал открытым прокси (SSRF):
 * сервер обслуживает только те url, что сам же и сгенерировал из своих обложек.
 */
import { createHash, createHmac } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from './env.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = path.resolve(here, '../data/imgcache')

const MAX_BYTES = 8 * 1024 * 1024
const TIMEOUT_MS = 8000

const sign = (url: string) =>
  createHmac('sha256', env.webhookSecret).update(`img:${url}`).digest('hex').slice(0, 16)

/**
 * Внешнюю обложку заменяем на ссылку через наш кэш; свои (/api/cover) и data:
 * оставляем как есть.
 */
export function proxyCover(url: string | null): string | null {
  if (!url) return null
  if (url.startsWith('data:')) return url
  if (url.includes('/api/cover/') || url.includes('/api/img')) return url
  if (/^https?:\/\//.test(url)) return `/api/img?u=${encodeURIComponent(url)}&s=${sign(url)}`
  return url
}

const keyOf = (url: string) => createHash('sha1').update(url).digest('hex')

/**
 * Отдаёт обложку по внешнему url (с проверкой подписи). Сначала с диска, при
 * промахе — тянет с origin и кэширует. null — если подпись не сошлась или не вышло.
 */
export async function cachedImage(
  url: string,
  sig: string,
): Promise<{ body: Buffer; type: string } | null> {
  if (!/^https?:\/\//.test(url) || sign(url) !== sig) return null
  await mkdir(CACHE_DIR, { recursive: true })
  const base = path.join(CACHE_DIR, keyOf(url))

  try {
    const [body, type] = await Promise.all([readFile(base), readFile(`${base}.type`, 'utf8')])
    return { body, type }
  } catch {
    /* промах кэша — тянем ниже */
  }

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
    const body = Buffer.from(await res.arrayBuffer())
    if (!body.length || body.length > MAX_BYTES) return null
    await Promise.all([writeFile(base, body), writeFile(`${base}.type`, type)]).catch(() => {})
    return { body, type }
  } catch {
    return null
  }
}
