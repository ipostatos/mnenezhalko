/**
 * P2.3/P2.4 аудита 2026-07-28: lifecycle файлов data/covers (временные фото
 * распознавания без чистки копили гигабайты) и протухание барахолки.
 * Запуск: npm run test -w server
 */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `lifecycle-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { housekeepCovers, COVER_ORPHAN_TTL_MS } = await import('./covers.js')
const { expireMarketItems, MARKET_TTL_DAYS } = await import('./market.js')

const DAY = 86_400_000
const DIR = join(tmpdir(), `covers-test-${randomUUID()}`)

beforeEach(async () => {
  await prisma.marketItem.deleteMany()
  await prisma.book.deleteMany()
  await prisma.user.deleteMany()
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(join(DIR, 'variants'), { recursive: true })
})

after(async () => {
  await prisma.$disconnect()
  rmSync(DIR, { recursive: true, force: true })
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

function coverFile(name: string, ageMs: number) {
  const full = join(DIR, name)
  writeFileSync(full, 'x'.repeat(100))
  const t = new Date(Date.now() - ageMs)
  utimesSync(full, t, t)
  return full
}

test('прикреплённая обложка не удаляется, осиротевшая старая — удаляется, свежая — ждёт', async () => {
  const attached = `${randomUUID()}.webp`
  const orphanOld = `${randomUUID()}.webp`
  const orphanFresh = `${randomUUID()}.webp`
  coverFile(attached, 10 * DAY)
  coverFile(orphanOld, 10 * DAY)
  coverFile(orphanFresh, 3600_000) // час назад — может быть черновик
  await prisma.book.create({
    data: { title: 'С фото', active: true, reviewStatus: 'approved', coverUrl: `https://x/api/cover/${attached}` },
  })

  const r = await housekeepCovers(Date.now(), DIR)
  assert.equal(r.removed, 1)
  assert.ok(existsSync(join(DIR, attached)), 'прикреплённая должна остаться')
  assert.ok(!existsSync(join(DIR, orphanOld)), 'старая осиротевшая должна удалиться')
  assert.ok(existsSync(join(DIR, orphanFresh)), 'свежая ждёт TTL — вдруг черновик')
  assert.ok(COVER_ORPHAN_TTL_MS >= 24 * 3600_000, 'щедрый запас на черновики')
})

test('обложка мягко удалённой книги сохраняется (история), варианты сирот чистятся', async () => {
  const deletedCover = `${randomUUID()}.webp`
  coverFile(deletedCover, 10 * DAY)
  await prisma.book.create({
    data: {
      title: 'Удалённая',
      active: false,
      reviewStatus: 'deleted',
      deletedAt: new Date(),
      coverUrl: `https://x/api/cover/${deletedCover}`,
    },
  })
  // вариант файла, которого больше нет
  writeFileSync(join(DIR, 'variants', `96-${randomUUID()}.webp.webp`), 'v')

  const r = await housekeepCovers(Date.now(), DIR)
  assert.ok(existsSync(join(DIR, deletedCover)), 'история важнее килобайт')
  assert.equal(r.removed, 1, 'осиротевший вариант удалён')
})

test('барахолка: протухшие и legacy-объявления закрываются, свежие остаются', async () => {
  await prisma.user.upsert({ where: { tgId: 900n }, create: { tgId: 900n }, update: {} })
  const now = new Date()
  const mk = (title: string, data: Record<string, unknown>) =>
    prisma.marketItem.create({
      data: { city: 'Warszawa', kind: 'give', title, authorTg: 900n, status: 'active', ...data },
    })
  await mk('Протухло', { expiresAt: new Date(now.getTime() - DAY) })
  await mk('Свежее', { expiresAt: new Date(now.getTime() + DAY) })
  await mk('Legacy старое', { expiresAt: null, bumpedAt: new Date(now.getTime() - (MARKET_TTL_DAYS + 5) * DAY) })
  await mk('Legacy свежее', { expiresAt: null, bumpedAt: now })

  const r = await expireMarketItems(now)
  assert.equal(r.closed, 2)
  const titles = r.items.map((i) => i.title).sort()
  assert.deepEqual(titles, ['Legacy старое', 'Протухло'])
  const active = await prisma.marketItem.findMany({ where: { status: 'active' } })
  assert.deepEqual(active.map((i) => i.title).sort(), ['Legacy свежее', 'Свежее'])
})

test('повторный прогон ничего не закрывает повторно', async () => {
  await prisma.user.upsert({ where: { tgId: 901n }, create: { tgId: 901n }, update: {} })
  await prisma.marketItem.create({
    data: {
      city: 'Warszawa',
      kind: 'give',
      title: 'Одноразово',
      authorTg: 901n,
      status: 'active',
      expiresAt: new Date(Date.now() - DAY),
    },
  })
  const first = await expireMarketItems()
  assert.equal(first.closed, 1)
  const second = await expireMarketItems()
  assert.equal(second.closed, 0)
})
