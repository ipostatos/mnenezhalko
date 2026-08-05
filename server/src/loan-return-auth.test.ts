/**
 * A1 (P0, продуктовая команда 5.08.2026): возврат книги подтверждает ТОЛЬКО
 * владелец. Читатель не должен закрыть чужую выдачу ни кнопкой, ни прямым
 * запросом к API. Regression-тест бьёт прямо в endpoint от имени читателя.
 *
 * Проверяем на уровне HTTP (а не только функции), потому что суть бага была в
 * том, что права держались на скрытии кнопки, а сервер пускал любого участника.
 *
 * Запуск: npm run test -w server
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import crypto, { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import Fastify from 'fastify'

const DB_FILE = join(tmpdir(), `loan-return-auth-${randomUUID()}.db`)
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

const OWNER = 970101n
const READER = 970102n
const STRANGER = 970103n

const app = Fastify()

function asUser(tgId: bigint) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: Number(tgId), username: `u${tgId}`, first_name: 'Имя' }),
  })
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n')
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN!).digest()
  params.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'))
  return { 'X-Init-Data': params.toString() }
}

const ret = (id: string, tgId: bigint | null) =>
  app.inject({
    method: 'POST',
    url: `/api/loans/${id}/return`,
    headers: tgId === null ? {} : asUser(tgId),
  })

const reopen = (id: string, tgId: bigint | null) =>
  app.inject({
    method: 'POST',
    url: `/api/loans/${id}/reopen`,
    headers: tgId === null ? {} : asUser(tgId),
  })

/** Активная выдача: книга OWNER на руках у READER. */
async function seedActiveLoan() {
  // ownerTg/holderTg у Loan — FK на User.tgId, поэтому обе стороны заводим как User
  await prisma.user.create({ data: { tgId: OWNER, username: 'u970101' } })
  await prisma.user.create({ data: { tgId: READER, username: 'u970102' } })
  const owner = await prisma.librarian.create({
    data: { name: 'Владелец', telegram: 'u970101', telegramNorm: 'u970101', city: 'Warszawa' },
  })
  const book = await prisma.book.create({
    data: { title: 'Книга', ownerId: owner.id, addedByTg: OWNER, source: 'bot', status: 'busy' },
  })
  const loan = await prisma.loan.create({
    data: {
      title: 'Книга',
      bookId: book.id,
      ownerTg: OWNER,
      holderTg: READER,
      status: 'active',
      activeBookId: book.id,
    },
  })
  return loan
}

before(async () => {
  await registerRoutes(app)
  await app.ready()
})

beforeEach(async () => {
  await prisma.loanEvent.deleteMany().catch(() => {})
  await prisma.loan.deleteMany()
  await prisma.waiting.deleteMany().catch(() => {})
  await prisma.book.deleteMany()
  await prisma.librarian.deleteMany()
  await prisma.user.deleteMany()
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

test('читатель НЕ может отметить возврат чужой книги: прямой запрос → 403', async () => {
  const loan = await seedActiveLoan()
  const r = await ret(loan.id, READER)
  assert.equal(r.statusCode, 403)
  assert.equal(r.json().error, 'forbidden')
  // выдача осталась активной, книга по-прежнему занята
  const after = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })
  assert.equal(after.status, 'active')
})

test('чужой пользователь тоже получает 403', async () => {
  const loan = await seedActiveLoan()
  const r = await ret(loan.id, STRANGER)
  assert.equal(r.statusCode, 403)
})

test('аноним без подписи Telegram → 401', async () => {
  const loan = await seedActiveLoan()
  const r = await ret(loan.id, null)
  assert.equal(r.statusCode, 401)
})

test('владелец отмечает возврат: 200, выдача закрыта, книга свободна', async () => {
  const loan = await seedActiveLoan()
  const r = await ret(loan.id, OWNER)
  assert.equal(r.statusCode, 200)
  const after = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })
  assert.equal(after.status, 'returned')
  assert.equal(after.activeBookId, null)
  const book = await prisma.book.findUniqueOrThrow({ where: { id: after.bookId! } })
  assert.equal(book.status, 'free')
})

test('повторное подтверждение владельцем идемпотентно: снова 200, без второго события', async () => {
  const loan = await seedActiveLoan()
  await ret(loan.id, OWNER)
  const first = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })
  const eventsAfterFirst = await prisma.loanEvent.count({ where: { loanId: loan.id, kind: 'returned' } })

  const again = await ret(loan.id, OWNER)
  assert.equal(again.statusCode, 200)
  const second = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })
  // returnedAt не перезаписан, второго события 'returned' не появилось
  assert.deepEqual(second.returnedAt, first.returnedAt)
  const eventsAfterSecond = await prisma.loanEvent.count({ where: { loanId: loan.id, kind: 'returned' } })
  assert.equal(eventsAfterSecond, eventsAfterFirst)
})

test('undo возврата тоже только владельцу: читателю 403, владельцу — ок', async () => {
  const loan = await seedActiveLoan()
  await ret(loan.id, OWNER)

  const byReader = await reopen(loan.id, READER)
  assert.equal(byReader.statusCode, 403)

  const byOwner = await reopen(loan.id, OWNER)
  assert.equal(byOwner.statusCode, 200)
  const after = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })
  assert.equal(after.status, 'active')
})
