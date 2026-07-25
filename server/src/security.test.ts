/**
 * Тесты безопасности (аудит 2026-07-25). Запуск: npm run test -w server
 *
 * Покрывают три вектора:
 *  - выдача книги: только своей, одобренной, свободной; нет второй активной;
 *  - предохранитель массовой деактивации при неполном ответе Notion;
 *  - SSRF-фильтр адресов обложек (приватные/служебные адреса и схемы).
 */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `sec-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { createLoan } = await import('./loans.js')
const { deactivationGuard } = await import('./sync.js')
const { isPrivateIp, isSafeCoverUrl } = await import('./net.js')

async function seedUser(tgId: bigint) {
  await prisma.user.upsert({ where: { tgId }, create: { tgId }, update: {} })
}

async function seedBook(o: {
  ownerTg: bigint
  reviewStatus?: string
  status?: string
  active?: boolean
}) {
  // Librarian.tgId — внешний ключ на User.tgId, поэтому владельца заводим первым
  await seedUser(o.ownerTg)
  const lib = await prisma.librarian.create({ data: { name: `L${o.ownerTg}`, tgId: o.ownerTg } })
  return prisma.book.create({
    data: {
      title: 'Книга',
      reviewStatus: o.reviewStatus ?? 'approved',
      status: o.status ?? 'free',
      active: o.active ?? true,
      ownerId: lib.id,
      source: 'bot',
    },
  })
}

beforeEach(async () => {
  await prisma.loanEvent.deleteMany()
  await prisma.loan.deleteMany()
  await prisma.book.deleteMany()
  await prisma.librarian.deleteMany()
  await prisma.user.deleteMany()
})

after(async () => {
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {
    /* уже нет */
  }
})

// ── P0: выдача книги ─────────────────────────────────────────────
test('владелец выдаёт свою свободную одобренную книгу — ок, книга становится busy', async () => {
  const book = await seedBook({ ownerTg: 1n })
  const loan = await createLoan({ ownerTg: 1n, title: 'Книга', bookId: book.id, holder: '@reader' })
  assert.equal(loan.bookId, book.id)
  const after = await prisma.book.findUnique({ where: { id: book.id } })
  assert.equal(after?.status, 'busy')
})

test('нельзя выдать ЧУЖУЮ книгу (bookId из тела запроса)', async () => {
  const book = await seedBook({ ownerTg: 1n })
  await assert.rejects(
    () => createLoan({ ownerTg: 999n, title: 'Книга', bookId: book.id, holder: '@thief' }),
    /not_your_book/,
  )
  // чужая книга не должна была стать занятой
  const after = await prisma.book.findUnique({ where: { id: book.id } })
  assert.equal(after?.status, 'free')
})

test('нельзя выдать книгу дважды (вторая активная выдача заблокирована)', async () => {
  const book = await seedBook({ ownerTg: 1n })
  await createLoan({ ownerTg: 1n, title: 'Книга', bookId: book.id, holder: '@reader_one' })
  await assert.rejects(
    () => createLoan({ ownerTg: 1n, title: 'Книга', bookId: book.id, holder: '@reader_two' }),
    /book_busy/,
  )
  const loans = await prisma.loan.count({ where: { bookId: book.id, status: 'active' } })
  assert.equal(loans, 1)
})

test('нельзя выдать неодобренную (pending) книгу', async () => {
  const book = await seedBook({ ownerTg: 1n, reviewStatus: 'pending' })
  await assert.rejects(
    () => createLoan({ ownerTg: 1n, title: 'Книга', bookId: book.id, holder: '@reader_one' }),
    /book_not_approved/,
  )
})

test('выдача книги «не с полки» (без bookId) свободна — проверок владельца нет', async () => {
  await seedUser(5n)
  const loan = await createLoan({ ownerTg: 5n, title: 'Своя бумажная', holder: '@friend' })
  assert.equal(loan.bookId, null)
})

// ── P0: предохранитель синка ─────────────────────────────────────
test('deactivationGuard: пропало >15% при заметном объёме → пропустить деактивацию', () => {
  assert.equal(deactivationGuard(100, 20).skip, true) // 20% — подозрительно
  assert.equal(deactivationGuard(100, 5).skip, false) // 5% — норма
  assert.equal(deactivationGuard(10, 9).skip, false) // объём мал — не срабатываем
  assert.equal(deactivationGuard(0, 0).skip, false)
})

// ── SSRF: адреса обложек ─────────────────────────────────────────
test('isPrivateIp: приватные/служебные → true, публичные → false', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '169.254.169.254', '172.16.9.9', '::1', '::ffff:127.0.0.1'])
    assert.equal(isPrivateIp(ip), true, ip)
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34'])
    assert.equal(isPrivateIp(ip), false, ip)
})

test('isSafeCoverUrl: блокирует localhost/приватные IP/чужие схемы, пускает публичный домен', () => {
  for (const u of [
    'http://localhost/x.jpg',
    'http://127.0.0.1/x.jpg',
    'http://169.254.169.254/latest/meta-data',
    'http://192.168.1.1/cover.png',
    'ftp://example.com/x.jpg',
    'file:///etc/passwd',
    'not a url',
  ])
    assert.equal(isSafeCoverUrl(u), false, u)
  for (const u of [
    'https://covers.openlibrary.org/b/isbn/9780140328721-L.jpg',
    'https://cdn.azbooka.ru/cv/w1100/x.jpg',
  ])
    assert.equal(isSafeCoverUrl(u), true, u)
})
