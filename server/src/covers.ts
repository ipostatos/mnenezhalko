/**
 * Хранение обложек, снятых на телефон.
 *
 * Файл кладём рядом с базой (`server/data/covers`), наружу отдаём по
 * `/api/cover/<файл>` — эта же ссылка уходит в поле Cover общей таблицы Notion,
 * поэтому она обязана быть абсолютной и стабильной.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { env } from './env.js'
import { isSupportedMedia, type MediaType } from './vision.js'

const here = path.dirname(fileURLToPath(import.meta.url))
export const COVERS_DIR = path.resolve(here, '../data/covers')

const EXT: Record<MediaType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}
const BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
}

/** ~6 МБ картинки; Mini App присылает сжатую, это запас на всякий случай. */
const MAX_BYTES = 6 * 1024 * 1024

export type Decoded = { data: string; buffer: Buffer; mediaType: MediaType }

/**
 * Хранимый максимум — с запасом на будущие варианты показа (не размер под
 * конкретную миниатюру, см. LIST_W/CARD_W в imgcache.ts).
 */
const STORE_MAX_W = 1600
const STORE_QUALITY = 82

/**
 * Телефонные фото книжных полок часто несут EXIF-ориентацию и GPS-координаты
 * места съёмки — а эта ссылка публична (уходит в общую таблицу Notion и
 * отдаётся всем через `/api/cover/<файл>`). Прогоняем через sharp: `rotate()`
 * переносит EXIF-поворот в сами пиксели, ресайз убирает лишнее разрешение,
 * а перекодирование в webp по умолчанию НЕ переносит метаданные (sharp
 * сохраняет EXIF/ICC только если явно попросить `withMetadata()` — здесь
 * специально этого не делаем).
 * GIF не трогаем: анимации у обложек книг не бывает, а resize без
 * `{ animated: true }` молча схлопнул бы её до одного кадра.
 */
export async function normalizeForStorage(d: Decoded): Promise<Decoded> {
  if (d.mediaType === 'image/gif') return d
  try {
    const buffer = await sharp(d.buffer, { failOn: 'none' })
      .rotate()
      .resize({ width: STORE_MAX_W, withoutEnlargement: true })
      .webp({ quality: STORE_QUALITY })
      .toBuffer()
    return { buffer, mediaType: 'image/webp', data: buffer.toString('base64') }
  } catch {
    return d // не осилили (битый/экзотический файл) — сохраняем как получили, не роняем загрузку
  }
}

/** `data:image/jpeg;base64,...` → байты. Бросает понятную ошибку при мусоре. */
export function decodeDataUrl(dataUrl: string): Decoded {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl.trim())
  if (!m) throw new Error('bad_image')
  const [, mediaType, data] = m
  if (!isSupportedMedia(mediaType)) throw new Error('unsupported_image')
  const buffer = Buffer.from(data, 'base64')
  if (!buffer.length) throw new Error('bad_image')
  if (buffer.length > MAX_BYTES) throw new Error('image_too_big')
  return { data, buffer, mediaType }
}

export async function saveCover(input: Decoded): Promise<{ file: string; url: string }> {
  const d = await normalizeForStorage(input)
  await mkdir(COVERS_DIR, { recursive: true })
  const file = `${randomUUID()}.${EXT[d.mediaType]}`
  await writeFile(path.join(COVERS_DIR, file), d.buffer)
  return { file, url: coverUrlOf(file) }
}

/** Абсолютная ссылка, если знаем свой публичный адрес, иначе относительная. */
export const coverUrlOf = (file: string) =>
  `${env.publicUrl || ''}/api/cover/${file}`

export async function readCover(file: string): Promise<{ body: Buffer; type: string } | null> {
  if (!/^[\w-]+\.(jpg|png|webp|gif)$/.test(file)) return null
  try {
    const body = await readFile(path.join(COVERS_DIR, file))
    return { body, type: BY_EXT[file.split('.').pop()!] }
  } catch {
    return null
  }
}

/**
 * Превью собственной обложки шириной `w` — тот же sharp-конвейер, что у внешних
 * (imgcache.ts), только источник локальный. Без этого фото с телефона (до
 * 1600px, сотни КБ) уезжало в строку списка 44 CSS px как есть. Варианты
 * лежат рядом (`variants/<w>-<файл>.webp`) и создаются на первый запрос;
 * имя исходного файла — UUID, так что ссылка с ?w= остаётся immutable.
 */
const VARIANTS_DIR = path.join(COVERS_DIR, 'variants')
const VARIANT_QUALITY = 78

export const variantName = (file: string, w: number) => `${w}-${file}.webp`

export async function readCoverVariant(
  file: string,
  w: number,
): Promise<{ body: Buffer; type: string } | null> {
  if (!/^[\w-]+\.(jpg|png|webp|gif)$/.test(file)) return null
  // GIF не ресайзим (см. normalizeForStorage) — отдаём как есть
  if (file.endsWith('.gif')) return readCover(file)
  try {
    const body = await readFile(path.join(VARIANTS_DIR, variantName(file, w)))
    return { body, type: 'image/webp' }
  } catch {
    /* варианта ещё нет — соберём ниже */
  }
  const orig = await readCover(file)
  if (!orig) return null
  try {
    const body = await sharp(orig.body, { failOn: 'none' })
      .rotate()
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality: VARIANT_QUALITY })
      .toBuffer()
    await mkdir(VARIANTS_DIR, { recursive: true })
    await writeFile(path.join(VARIANTS_DIR, variantName(file, w)), body).catch(() => {})
    return { body, type: 'image/webp' }
  } catch {
    return orig // битый файл — лучше оригинал, чем ничего
  }
}

/** Есть ли уже готовый вариант на диске (для прогрева) — stat, без чтения. */
export async function isCoverVariantCached(file: string, w: number): Promise<boolean> {
  if (file.endsWith('.gif')) return true
  try {
    await stat(path.join(VARIANTS_DIR, variantName(file, w)))
    return true
  } catch {
    return false
  }
}

/** Скачивает фото из Telegram (file_id) и сохраняет как обложку. */
export async function saveCoverFromTelegram(fileId: string): Promise<{ file: string; url: string; decoded: Decoded } | null> {
  const meta = (await (
    await fetch(`https://api.telegram.org/bot${env.botToken}/getFile?file_id=${fileId}`)
  ).json()) as { ok: boolean; result?: { file_path: string } }
  if (!meta.ok || !meta.result) return null

  const res = await fetch(
    `https://api.telegram.org/file/bot${env.botToken}/${meta.result.file_path}`,
  )
  if (!res.ok) return null
  const buffer = Buffer.from(await res.arrayBuffer())
  const type = res.headers.get('content-type') || 'image/jpeg'
  const mediaType = (isSupportedMedia(type) ? type : 'image/jpeg') as MediaType
  const decoded: Decoded = { buffer, mediaType, data: buffer.toString('base64') }
  const saved = await saveCover(decoded)
  return { ...saved, decoded }
}
