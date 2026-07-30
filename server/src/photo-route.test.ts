/**
 * `/api/photo/:fileId` (аудит 2026-07-28, P0.5): была единственной ручкой без
 * авторизации, лимитов и таймаута — открытый прокси к Telegram-файлам с
 * буферизацией до 20 МБ. Теперь обслуживаются только подписанные сервером
 * ссылки; сеть в тестах подменена.
 * Запуск: npm run test -w server
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import Fastify from 'fastify'
import sharp from 'sharp'

const DB_FILE = join(tmpdir(), `photo-route-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'
process.env.BOT_TOKEN = '123456:test-token-for-signature'
process.env.NOTION_TOKEN_V2 = ''

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { registerRoutes, photoProxyUrl } = await import('./routes.js')

const app = Fastify()
let realFetch: typeof globalThis.fetch
/** чем ответит «Telegram» в текущем тесте */
let fakeTelegram: (url: string) => Promise<Response>

before(async () => {
  await registerRoutes(app)
  await app.ready()
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input)
    if (url.includes('api.telegram.org')) return fakeTelegram(url)
    return realFetch(input, init)
  }) as typeof fetch
})

after(async () => {
  globalThis.fetch = realFetch
  await app.close()
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

const FILE_ID = 'AgACAgIAAxkBAAI'
const okMeta = () =>
  ({ ok: true, status: 200, json: async () => ({ ok: true, result: { file_path: 'photos/1.jpg' } }) }) as unknown as Response
const imageResponse = async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#eba788' } })
    .png()
    .toBuffer()
  return new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } })
}

test('без подписи — 403, это больше не открытый прокси', async () => {
  const r = await app.inject({ method: 'GET', url: `/api/photo/${FILE_ID}` })
  assert.equal(r.statusCode, 403)
})

test('кривая подпись — 403', async () => {
  const r = await app.inject({ method: 'GET', url: `/api/photo/${FILE_ID}?s=0123456789abcdef` })
  assert.equal(r.statusCode, 403)
})

test('мусорный fileId отсекается до похода в Telegram', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/photo/..%2F..%2Fetc?s=x' })
  assert.equal(r.statusCode, 400)
})

test('валидная подписанная ссылка отдаёт webp-превью', async () => {
  fakeTelegram = async (url) => (url.includes('getFile') ? okMeta() : imageResponse())
  const r = await app.inject({ method: 'GET', url: photoProxyUrl(FILE_ID) })
  assert.equal(r.statusCode, 200)
  assert.equal(r.headers['content-type'], 'image/webp')
  assert.ok(Number(r.headers['content-length'] ?? r.rawPayload.length) > 0)
})

test('🔥 JPEG под видом octet-stream проходит: так его и отдаёт Telegram', async () => {
  // Регресс с прода 30.07.2026: файловый CDN Telegram отвечает
  // `application/octet-stream` на обычное фото, а ручка отбивала такое 415 —
  // ни одно фото барахолки не показывалось. Решает декод, а не заголовок.
  fakeTelegram = async (url) => {
    if (url.includes('getFile')) return okMeta()
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#eba788' } })
      .jpeg()
      .toBuffer()
    return new Response(new Uint8Array(jpeg), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    })
  }
  const r = await app.inject({ method: 'GET', url: photoProxyUrl(FILE_ID) })
  assert.equal(r.statusCode, 200)
  assert.equal(r.headers['content-type'], 'image/webp')
})

test('не-картинка не проходит независимо от заголовка — 415', async () => {
  // тот же html, но теперь его отвергает декод, а не Content-Type
  fakeTelegram = async (url) =>
    url.includes('getFile')
      ? okMeta()
      : new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
  const r = await app.inject({ method: 'GET', url: photoProxyUrl(FILE_ID) })
  assert.equal(r.statusCode, 415)
})

test('не-картинка с честным image/* — тоже 415', async () => {
  fakeTelegram = async (url) =>
    url.includes('getFile')
      ? okMeta()
      : new Response('совсем не картинка', { status: 200, headers: { 'content-type': 'image/png' } })
  const r = await app.inject({ method: 'GET', url: photoProxyUrl(FILE_ID) })
  assert.equal(r.statusCode, 415)
})

test('мусор под видом image/* не проходит фактический декод — 415', async () => {
  fakeTelegram = async (url) =>
    url.includes('getFile')
      ? okMeta()
      : new Response('не картинка вовсе', { status: 200, headers: { 'content-type': 'image/jpeg' } })
  const r = await app.inject({ method: 'GET', url: photoProxyUrl(FILE_ID) })
  assert.equal(r.statusCode, 415)
})

test('слишком большой файл обрывается по ходу чтения — 413', async () => {
  fakeTelegram = async (url) => {
    if (url.includes('getFile')) return okMeta()
    const big = new Uint8Array(6 * 1024 * 1024) // больше потолка в 5 МБ
    return new Response(big, { status: 200, headers: { 'content-type': 'image/jpeg' } })
  }
  const r = await app.inject({ method: 'GET', url: photoProxyUrl(FILE_ID) })
  assert.equal(r.statusCode, 413)
})

test('Telegram не нашёл файл — 404', async () => {
  fakeTelegram = async () =>
    ({ ok: true, status: 200, json: async () => ({ ok: false }) }) as unknown as Response
  const r = await app.inject({ method: 'GET', url: photoProxyUrl(FILE_ID) })
  assert.equal(r.statusCode, 404)
})

test('сбой Telegram API — 502, без падения процесса', async () => {
  fakeTelegram = async () => {
    throw new Error('ECONNRESET')
  }
  const r = await app.inject({ method: 'GET', url: photoProxyUrl(FILE_ID) })
  assert.equal(r.statusCode, 502)
})

test('rate limit: шквал запросов упирается в 429', async () => {
  fakeTelegram = async (url) => (url.includes('getFile') ? okMeta() : imageResponse())
  let got429 = false
  for (let i = 0; i < 70; i++) {
    const r = await app.inject({ method: 'GET', url: photoProxyUrl(FILE_ID) })
    if (r.statusCode === 429) {
      got429 = true
      break
    }
  }
  assert.ok(got429, 'после 60 запросов в минуту с одного IP должен быть 429')
})
