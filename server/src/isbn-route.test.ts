/**
 * Ручка `/api/isbn` на реальном Fastify: она ходит во внешние каталоги, поэтому
 * не должна быть открытым прокси — только по подписи Telegram и только для
 * похожего на ISBN кода. Сеть подменена, живые каталоги не дёргаем.
 * Запуск: npm run test -w server
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import crypto, { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import Fastify from 'fastify'

const DB_FILE = join(tmpdir(), `isbn-route-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'
process.env.BOT_TOKEN = '123456:test-token-for-signature'
process.env.NOTION_TOKEN_V2 = ''

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { registerRoutes } = await import('./routes.js')

function signInitData(user: { id: string; username?: string }): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify(user),
  })
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n')
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN!).digest()
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex')
  params.set('hash', hash)
  return params.toString()
}

const SIGNED = { 'x-init-data': signInitData({ id: '777000111', username: 'reader' }) }

const app = Fastify()
let realFetch: typeof globalThis.fetch

before(async () => {
  await registerRoutes(app)
  await app.ready()
  realFetch = globalThis.fetch
  // внешние каталоги подменяем: тест не должен зависеть от сети
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    const body = url.includes('openlibrary.org/api/books')
      ? { 'ISBN:9780441013593': { title: 'Dune', authors: [{ name: 'Frank Herbert' }] } }
      : {}
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  }) as typeof fetch
})

test('без подписи Telegram ручка не работает — иначе это открытый прокси к каталогам', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/isbn?code=9780441013593' })
  assert.equal(r.statusCode, 401)
})

test('мусор вместо ISBN отсекается до похода наружу', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/isbn?code=не-isbn', headers: SIGNED })
  assert.equal(r.statusCode, 400)
  assert.equal(r.json().error, 'bad_isbn')
})

test('по валидному ISBN возвращается книга', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/isbn?code=9780441013593', headers: SIGNED })
  assert.equal(r.statusCode, 200)
  assert.equal(r.json().book.title, 'Dune')
  assert.equal(r.json().book.author, 'Frank Herbert')
})

after(async () => {
  globalThis.fetch = realFetch
  await app.close()
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})
