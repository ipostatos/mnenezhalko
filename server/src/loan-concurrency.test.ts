/**
 * Целостность выдач под конкуренцией (stage 5 текущего аудита): нельзя создать
 * две активные выдачи одной книги, даже когда запросы приходят «одновременно»
 * (Promise.all на одном соединении — SQLite сериализует запись, поэтому это
 * реально проверяет логику отклонения второго запроса, а не просто везение).
 * Своя временная SQLite-база — прод не трогаем.
 * Запуск: npm run test -w server
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `loan-conc-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { createLoan, markReturned, reopenLoan } = await import('./loans.js')

after(async () => {
  await prisma.$disconnect()
  unlinkSync(DB_FILE)
})

let nextTg = 900_000n

/** Каждый вызов — свой владелец: тесты делят одну базу, tgId должен быть уникален. */
async function seedBook() {
  const ownerTg = nextTg++
  await prisma.user.create({ data: { tgId: ownerTg, username: `owner${ownerTg}` } })
  const librarian = await prisma.librarian.create({
    data: { name: 'Владелец', tgId: ownerTg, telegram: `owner${ownerTg}` },
  })
  const book = await prisma.book.create({
    data: {
      title: 'Спорная книга',
      ownerId: librarian.id,
      active: true,
      reviewStatus: 'approved',
      status: 'free',
    },
  })
  return { book, ownerTg }
}

test('конкурентная выдача: два одновременных запроса на одну книгу — успешен ровно один', async () => {
  const { book, ownerTg } = await seedBook()

  const results = await Promise.allSettled([
    createLoan({ ownerTg, bookId: book.id, title: book.title, holder: '@reader1' }),
    createLoan({ ownerTg, bookId: book.id, title: book.title, holder: '@reader2' }),
  ])

  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')
  assert.equal(fulfilled.length, 1, 'ровно один запрос должен пройти')
  assert.equal(rejected.length, 1, 'ровно один должен получить конфликт')
  assert.match((rejected[0] as PromiseRejectedResult).reason.message, /book_busy/)

  const activeLoans = await prisma.loan.count({ where: { bookId: book.id, status: 'active' } })
  assert.equal(activeLoans, 1, 'в базе должна остаться ровно одна активная выдача')

  const fresh = await prisma.book.findUniqueOrThrow({ where: { id: book.id } })
  assert.equal(fresh.status, 'busy')
})

test('undo возврата не конфликтует с новой выдачей той же книги (гонка reopenLoan × createLoan)', async () => {
  const { book, ownerTg } = await seedBook()
  const loan = await createLoan({ ownerTg, bookId: book.id, title: book.title, holder: '@reader1' })
  const returned = await markReturned(loan.id, ownerTg)
  assert.equal(returned?.status, 'returned')
  const freedBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } })
  assert.equal(freedBook.status, 'free')

  const results = await Promise.allSettled([
    reopenLoan(loan.id, ownerTg),
    createLoan({ ownerTg, bookId: book.id, title: book.title, holder: '@reader2' }),
  ])

  const activeLoans = await prisma.loan.findMany({ where: { bookId: book.id, status: 'active' } })
  assert.equal(activeLoans.length, 1, `должна остаться ровно одна активная выдача, а не ${activeLoans.length}`)

  const fresh = await prisma.book.findUniqueOrThrow({ where: { id: book.id } })
  assert.equal(fresh.status, 'busy')

  // ровно одна из двух операций должна была пройти (либо undo, либо новая выдача — не обе)
  const outcomes = results.map((r) =>
    r.status === 'fulfilled' ? r.value : { error: (r.reason as Error).message },
  )
  const successes = outcomes.filter(
    (o: any) => (o && 'loan' in o) || (o && 'id' in o && !('error' in o)),
  )
  assert.equal(successes.length, 1, 'должна была пройти ровно одна из двух конкурирующих операций')
})

test('возврат: Loan.status и Book.status меняются согласованно (нет busy-книги без активной выдачи)', async () => {
  const { book, ownerTg } = await seedBook()
  const loan = await createLoan({ ownerTg, bookId: book.id, title: book.title, holder: '@reader1' })
  await markReturned(loan.id, ownerTg)

  const freshLoan = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })
  const freshBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } })
  assert.equal(freshLoan.status, 'returned')
  assert.equal(freshBook.status, 'free')

  const stillActive = await prisma.loan.count({ where: { bookId: book.id, status: 'active' } })
  assert.equal(stillActive, 0)
})

test('возврат с hideAfterReturn: мягкое удаление книги происходит той же транзакцией', async () => {
  const { book, ownerTg } = await seedBook()
  await prisma.book.update({ where: { id: book.id }, data: { hideAfterReturn: true } })
  const loan = await createLoan({ ownerTg, bookId: book.id, title: book.title, holder: '@reader1' })

  await markReturned(loan.id, ownerTg)

  const freshBook = await prisma.book.findUniqueOrThrow({ where: { id: book.id } })
  assert.equal(freshBook.active, false)
  assert.equal(freshBook.reviewStatus, 'deleted')
  assert.equal(freshBook.status, 'free')
  assert.equal(freshBook.hideAfterReturn, false)
  assert.ok(freshBook.deletedAt)
})
