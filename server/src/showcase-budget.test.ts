/**
 * Performance budget витрины карусели (stage 4.3 текущего аудита):
 * дефолт ≤ 12, жёсткий потолок ≤ 16, никакого отката к 80, ключ кэша
 * учитывает лимит, превью запрашивается нужной ширины, а не оригинал.
 * Своя временная SQLite-база — прод не трогаем.
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

const DB_FILE = join(tmpdir(), `showcase-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { registerRoutes } = await import('./routes.js')

const CITY = 'Тестоград'
const N_BOOKS = 40 // заведомо больше SHOWCASE_LIMIT_MAX — проверяем, что отдаётся не всё

before(async () => {
  await prisma.book.createMany({
    data: Array.from({ length: N_BOOKS }, (_, i) => ({
      title: `Книга ${i}`,
      coverUrl: `https://example.com/cover-${i}.jpg`,
      city: CITY,
      active: true,
      reviewStatus: 'approved',
    })),
  })
})

after(async () => {
  await prisma.$disconnect()
  unlinkSync(DB_FILE)
})

async function buildApp() {
  const app = Fastify()
  await registerRoutes(app)
  return app
}

test('витрина: без лимита в запросе — не больше SHOWCASE_LIMIT_DEFAULT (12), не 80', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: `/api/showcase?city=${encodeURIComponent(CITY)}` })
  const data = res.json() as Array<{ coverUrl: string }>
  assert.ok(data.length <= 12, `ожидали ≤12, получили ${data.length}`)
  assert.ok(data.length > 0)
  await app.close()
})

test('витрина: запрошенный лимит выше жёсткого потолка зажимается до SHOWCASE_LIMIT_MAX (16)', async () => {
  const app = await buildApp()
  const res = await app.inject({
    method: 'GET',
    url: `/api/showcase?city=${encodeURIComponent(CITY)}&limit=999`,
  })
  const data = res.json() as Array<{ coverUrl: string }>
  assert.ok(data.length <= 16, `ожидали ≤16 даже при limit=999, получили ${data.length}`)
  await app.close()
})

test('витрина: ключ кэша учитывает лимит — разные лимиты не путаются между собой', async () => {
  const app = await buildApp()
  const small = (
    await app.inject({ method: 'GET', url: `/api/showcase?city=${encodeURIComponent(CITY)}&limit=3` })
  ).json() as Array<unknown>
  const big = (
    await app.inject({ method: 'GET', url: `/api/showcase?city=${encodeURIComponent(CITY)}&limit=16` })
  ).json() as Array<unknown>
  assert.equal(small.length, 3)
  assert.equal(big.length, 16)
  await app.close()
})

test('витрина: обложка отдаётся превью нужной ширины (карусель), не оригиналом', async () => {
  const app = await buildApp()
  const res = await app.inject({ method: 'GET', url: `/api/showcase?city=${encodeURIComponent(CITY)}` })
  const data = res.json() as Array<{ coverUrl: string }>
  for (const b of data) {
    assert.match(b.coverUrl, /^\/api\/img\?u=/, 'обложка должна идти через /api/img, не напрямую')
    assert.match(b.coverUrl, /[?&]w=320(&|$)/, 'карусель должна просить w=320 (CAROUSEL_W)')
  }
  await app.close()
})
