/**
 * Хранение обложек, снятых на телефон.
 *
 * Файл кладём рядом с базой (`server/data/covers`), наружу отдаём по
 * `/api/cover/<файл>` — эта же ссылка уходит в поле Cover общей таблицы Notion,
 * поэтому она обязана быть абсолютной и стабильной.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

export async function saveCover(d: Decoded): Promise<{ file: string; url: string }> {
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
