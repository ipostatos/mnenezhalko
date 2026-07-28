/**
 * P0.4 аудита 2026-07-28: per-host семафор, ярусный негативный кэш и
 * резюмируемый фоновый прогрев превью каталога.
 * Запуск: npm run test -w server
 */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `prewarm-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { negativeTtlMs, acquireSlot, releaseSlot } = await import('./imgcache.js')
const { prewarmRun, loadPrewarmState, prewarmCoverage } = await import('./prewarm.js')

beforeEach(async () => {
  await prisma.book.deleteMany()
  await prisma.syncState.deleteMany()
})

after(async () => {
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

/* ── негативный кэш: TTL зависит от причины ── */

test('негативный TTL: 404/410 держим сутки, 5xx и таймауты — меньше часа', () => {
  const H = 3600_000
  assert.equal(negativeTtlMs('http_error', 404), 24 * H, 'ресурса нет — не долбим каждый час')
  assert.equal(negativeTtlMs('http_error', 410), 24 * H)
  assert.ok(negativeTtlMs('http_error', 503) <= H, '5xx может ожить — пробуем скоро')
  assert.ok(negativeTtlMs('timeout') <= H)
  assert.ok(negativeTtlMs('network') >= 6 * H, 'DNS-провалы — не чаще раза в 6 часов')
  assert.equal(negativeTtlMs('bad_content_type'), 24 * H)
  assert.equal(negativeTtlMs('private_host'), 24 * H)
})

/* ── двухуровневый семафор ── */

test('per-host лимит: третий запрос к хосту ждёт, другой хост проходит сразу', async () => {
  // два слота slow.example заняты
  await acquireSlot('slow.example')
  await acquireSlot('slow.example')

  let thirdStarted = false
  const third = acquireSlot('slow.example').then(() => {
    thirdStarted = true
  })
  // микротик: третий должен встать в очередь хоста
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(thirdStarted, false, 'третий запрос к тому же хосту должен ждать')

  // а другой хост при этом не блокируется зависшим (head-of-line blocking больше нет)
  await acquireSlot('fast.example')
  releaseSlot('fast.example')

  releaseSlot('slow.example')
  await third
  assert.equal(thirdStarted, true)
  releaseSlot('slow.example')
  releaseSlot('slow.example')
})

/* ── резюмируемый прогрев ── */

/** Книга с «своей» обложкой, файла которой нет на диске — сеть не нужна. */
async function seedBook(i: number, createdAt: Date) {
  return prisma.book.create({
    data: {
      title: `Книга ${i}`,
      kind: 'book',
      source: 'notion',
      active: true,
      reviewStatus: 'approved',
      coverUrl: `/api/cover/${randomUUID()}.webp`,
      createdAt,
    },
  })
}

test('прогрев проходит каталог и фиксирует завершение прохода', async () => {
  const base = Date.parse('2026-07-01T00:00:00Z')
  for (let i = 0; i < 5; i++) await seedBook(i, new Date(base + i * 60_000))
  const summary = await prewarmRun()
  assert.match(summary, /проход завершён/)
  const s = await loadPrewarmState()
  assert.ok(s.lastFullPassAt, 'завершённый проход должен быть записан')
  assert.equal(s.cursor, null)
})

test('курсор переживает «рестарт»: следующий прогон продолжает с места остановки', async () => {
  const base = Date.parse('2026-07-01T00:00:00Z')
  for (let i = 0; i < 5; i++) await seedBook(i, new Date(base + i * 60_000))
  // искусственно ставим курсор на третью книгу (как будто бюджет кончился)
  const third = await prisma.book.findFirst({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    skip: 2,
  })
  await prisma.syncState.create({
    data: {
      key: 'prewarm:state',
      value: JSON.stringify({
        version: 1,
        cursor: { createdAt: third!.createdAt.toISOString(), id: third!.id },
        lastFullPassAt: null,
        pass: { hit: 0, miss: 0, negative: 0, skipped: 3 },
      }),
    },
  })
  const summary = await prewarmRun()
  assert.match(summary, /обработано 2\b/, 'после курсора остались ровно 2 книги')
  const s = await loadPrewarmState()
  assert.equal(s.cursor, null)
  assert.ok(s.lastFullPassAt)
})

test('свежезавершённый проход не начинается заново — проверяется только хвост новых книг', async () => {
  const base = Date.parse('2026-07-01T00:00:00Z')
  for (let i = 0; i < 3; i++) await seedBook(i, new Date(base + i * 60_000))
  await prewarmRun() // полный проход
  const summary2 = await prewarmRun(Date.now() + 60_000) // спустя минуту
  assert.match(summary2, /хвост новых книг/, 'повторный полный проход раньше суток не нужен')
})

test('метрика покрытия отвечает и считает необработанные обложки', async () => {
  const base = Date.parse('2026-07-01T00:00:00Z')
  await seedBook(0, new Date(base))
  const c = await prewarmCoverage()
  assert.equal(c.totalCovers, 1)
  assert.equal(typeof c.coveragePct, 'number')
})
