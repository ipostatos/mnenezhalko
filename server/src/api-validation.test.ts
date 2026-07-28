/**
 * P2.1 аудита 2026-07-28: публичные ручки не падают 500-й на мусорных
 * параметрах, а произвольный ?city= не раздувает кэш и SyncState.
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

const DB_FILE = join(tmpdir(), `api-val-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'
process.env.BOT_TOKEN = '123456:test-token-for-signature'
process.env.NOTION_TOKEN_V2 = ''
process.env.ADMIN_IDS = '555001' // upsertUser пересчитывает isAdmin из окружения

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

const app = Fastify()

before(async () => {
  await registerRoutes(app)
  await app.ready()
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

test('GET /api/books?limit=abc — 200 с дефолтным лимитом, а не 500 (NaN в take)', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/books?limit=abc&offset=мусор' })
  assert.equal(r.statusCode, 200)
})

test('GET /api/books: отрицательные и гигантские limit/offset зажимаются', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/books?limit=-5&offset=-100' })
  assert.equal(r.statusCode, 200)
  const r2 = await app.inject({ method: 'GET', url: '/api/books?limit=99999' })
  assert.equal(r2.statusCode, 200)
})

test('произвольный ?city= в showcase — 400, SyncState не растёт', async () => {
  const junk = `Нью-Васюки-${randomUUID()}`
  const r = await app.inject({ method: 'GET', url: `/api/showcase?city=${encodeURIComponent(junk)}` })
  assert.equal(r.statusCode, 400)
  const rows = await prisma.syncState.count({ where: { key: { contains: junk } } })
  assert.equal(rows, 0, 'мусорный город не должен оставить строку кэша')
})

test('известный город в showcase работает', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/showcase?city=Warszawa' })
  assert.equal(r.statusCode, 200)
})

test('произвольный ?city= в facets — 400 (кэш по городу)', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/facets?city=abrakadabra' })
  assert.equal(r.statusCode, 400)
})

test('POST /api/events с кривой датой — 400, а не 500', async () => {
  await prisma.user.upsert({
    where: { tgId: 555001n },
    create: { tgId: 555001n, isAdmin: true },
    update: { isAdmin: true },
  })
  const headers = { 'x-init-data': signInitData({ id: '555001' }) }
  const r = await app.inject({
    method: 'POST',
    url: '/api/events',
    headers,
    payload: { city: 'Warszawa', title: 'Встреча', startsAt: 'не дата' },
  })
  assert.equal(r.statusCode, 400)
  const r2 = await app.inject({
    method: 'POST',
    url: '/api/events',
    headers,
    payload: { city: 'Город-которого-нет', title: 'Встреча', startsAt: '2026-08-01T18:00:00Z' },
  })
  assert.equal(r2.statusCode, 400)
})

test('POST /api/books: мусорный coverUrl (не URL) — 400, в базу не попадает', async () => {
  const headers = { 'x-init-data': signInitData({ id: '555002', username: 'lib_user' }) }
  const r = await app.inject({
    method: 'POST',
    url: '/api/books',
    headers,
    payload: { title: 'Книга с мусорной обложкой', coverUrl: 'javascript:alert(1)' },
  })
  assert.equal(r.statusCode, 400)
  const stored = await prisma.book.count({ where: { title: 'Книга с мусорной обложкой' } })
  assert.equal(stored, 0)
})

test('возврат чужой выдачи — 403, несуществующей — 404 (раньше оба были 404)', async () => {
  await prisma.user.upsert({ where: { tgId: 555003n }, create: { tgId: 555003n }, update: {} })
  await prisma.user.upsert({ where: { tgId: 555004n }, create: { tgId: 555004n }, update: {} })
  const loan = await prisma.loan.create({
    data: { title: 'Чужая книга', ownerTg: 555003n, holderUsername: 'someone', status: 'active' },
  })
  const stranger = { 'x-init-data': signInitData({ id: '555004' }) }
  const r = await app.inject({ method: 'POST', url: `/api/loans/${loan.id}/return`, headers: stranger, payload: {} })
  assert.equal(r.statusCode, 403)
  const r2 = await app.inject({ method: 'POST', url: '/api/loans/nope/return', headers: stranger, payload: {} })
  assert.equal(r2.statusCode, 404)
})
