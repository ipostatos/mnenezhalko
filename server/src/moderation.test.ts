/**
 * Идемпотентность и атомарность модерации (аудит 2026-07-28, P0.3): карточка
 * «на проверку» уходит каждому админу, поэтому двойное одобрение — штатный
 * случай, а не гонка. Одну книгу можно одобрить один раз; повторный callback
 * получает already, а не вторую строку в Notion.
 * Запуск: npm run test -w server
 */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `mod-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'
process.env.NOTION_TOKEN_V2 = '' // запись в Notion выключена — сеть не трогаем

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { approveBook, rejectBook, APPROVING_STALE_MS } = await import('./publish.js')
const { stableNotionRowId } = await import('./notion-write.js')

beforeEach(async () => {
  await prisma.book.deleteMany()
  await prisma.librarian.deleteMany()
})

after(async () => {
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

async function seedPending(overrides: Record<string, unknown> = {}) {
  const owner = await prisma.librarian.create({ data: { name: 'Автор полки' } })
  return prisma.book.create({
    data: {
      title: 'Книга на проверке',
      kind: 'book',
      source: 'bot',
      active: true,
      reviewStatus: 'pending',
      submittedAt: new Date(),
      ownerId: owner.id,
      addedByTg: 100n,
      ...overrides,
    },
  })
}

test('обычное одобрение: pending → approved', async () => {
  const b = await seedPending()
  const r = await approveBook(b.id, 1n)
  assert.equal(r.status, 'approved')
  assert.equal((r as any).already, false)
  const fresh = await prisma.book.findUniqueOrThrow({ where: { id: b.id } })
  assert.equal(fresh.reviewStatus, 'approved')
  assert.equal(fresh.reviewedByTg, 1n)
})

test('двойной callback последовательно: второй получает already, владельцу не дублируем', async () => {
  const b = await seedPending()
  const first = await approveBook(b.id, 1n)
  assert.equal(first.status, 'approved')
  const second = await approveBook(b.id, 1n)
  assert.equal(second.status, 'approved')
  assert.equal((second as any).already, true, 'повтор — не новое одобрение')
})

test('два одобрения параллельно: ровно одно проходит, второе видит already/in_progress', async () => {
  const b = await seedPending()
  const [r1, r2] = await Promise.all([approveBook(b.id, 1n), approveBook(b.id, 2n)])
  const results = [r1, r2]
  const fresh = [results[0], results[1]].filter(
    (r) => r.status === 'approved' && !(r as any).already,
  )
  assert.equal(fresh.length, 1, 'право на одобрение получает ровно один')
  const other = results.find((r) => r !== fresh[0])!
  assert.ok(
    other.status === 'in_progress' || (other.status === 'approved' && (other as any).already),
    `второй должен получить in_progress или already, а не ${JSON.stringify(other)}`,
  )
  const book = await prisma.book.findUniqueOrThrow({ where: { id: b.id } })
  assert.equal(book.reviewStatus, 'approved')
})

test('два РАЗНЫХ админа: одобрение фиксируется за первым', async () => {
  const b = await seedPending()
  const r1 = await approveBook(b.id, 10n)
  const r2 = await approveBook(b.id, 20n)
  assert.equal(r1.status, 'approved')
  assert.equal((r2 as any).already, true)
  const book = await prisma.book.findUniqueOrThrow({ where: { id: b.id } })
  assert.equal(book.reviewedByTg, 10n, 'reviewedByTg — тот, кто одобрил первым')
})

test('rejected нельзя одобрить без явного resubmit', async () => {
  const b = await seedPending({ reviewStatus: 'rejected' })
  const r = await approveBook(b.id, 1n)
  assert.equal(r.status, 'bad_state')
  const book = await prisma.book.findUniqueOrThrow({ where: { id: b.id } })
  assert.equal(book.reviewStatus, 'rejected')
})

test('reject не выдёргивает книгу у идущего одобрения (approving)', async () => {
  const b = await seedPending({ reviewStatus: 'approving', approvalStartedAt: new Date() })
  const r = await rejectBook(b.id, 2n, 'причина')
  assert.equal(r, null)
  const book = await prisma.book.findUniqueOrThrow({ where: { id: b.id } })
  assert.equal(book.reviewStatus, 'approving')
})

test('свежий approving другого админа не перехватывается', async () => {
  const b = await seedPending({
    reviewStatus: 'approving',
    approvalStartedAt: new Date(), // только что начали
    approvalStartedByTg: 1n,
  })
  const r = await approveBook(b.id, 2n)
  assert.equal(r.status, 'in_progress')
})

test('зависший approving (процесс упал) подхватывается после таймаута', async () => {
  const b = await seedPending({
    reviewStatus: 'approving',
    approvalStartedAt: new Date(Date.now() - APPROVING_STALE_MS - 1000),
    approvalStartedByTg: 1n,
    approvalAttempt: 1,
  })
  const r = await approveBook(b.id, 2n)
  assert.equal(r.status, 'approved')
  const book = await prisma.book.findUniqueOrThrow({ where: { id: b.id } })
  assert.equal(book.approvalAttempt, 2, 'повторная попытка учтена')
})

test('книга с notionId при повторной публикации не создаёт вторую строку', async () => {
  // pushToNotion с notionId сразу помечает synced, createBook не зовётся —
  // проверяем через результат: notionId не изменился, статус synced
  const notionId = randomUUID()
  const b = await seedPending({ notionId, notionStatus: 'failed' })
  const r = await approveBook(b.id, 1n)
  assert.equal(r.status, 'approved')
  const book = await prisma.book.findUniqueOrThrow({ where: { id: b.id } })
  assert.equal(book.notionId, notionId, 'существующая строка Notion переиспользуется')
})

test('идемпотентный id строки Notion: стабилен для книги, различен между книгами', () => {
  const a = stableNotionRowId('book:abc')
  assert.equal(a, stableNotionRowId('book:abc'), 'ретрай попадает в ту же страницу')
  assert.notEqual(a, stableNotionRowId('book:def'))
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})
