/**
 * Оценки и аннотации (issue #18): право оценивать даёт только прочтение,
 * оценка вешается на произведение, агрегат не расходится с отзывами.
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

const DB_FILE = join(tmpdir(), `reviews-test-${randomUUID()}.db`)
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
const {
  REVIEW_TEXT_MAX,
  canReview,
  deleteReview,
  listReviews,
  ratingFor,
  reportReview,
  upsertReview,
  validateReview,
  workKeyOf,
} = await import('./reviews.js')

const READER = 700001n
const READER2 = 700002n
const OWNER = 700003n
const STRANGER = 700004n

function signInitData(user: { id: string; username?: string; first_name?: string }): string {
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

const asUser = (tg: bigint, firstName = 'Читатель') => ({
  'x-init-data': signInitData({ id: String(tg), first_name: firstName }),
})

const app = Fastify()

before(async () => {
  await registerRoutes(app)
  await app.ready()
})

beforeEach(async () => {
  await prisma.review.deleteMany()
  await prisma.workRating.deleteMany()
  await prisma.loanEvent.deleteMany()
  await prisma.loan.deleteMany()
  await prisma.book.deleteMany()
  await prisma.librarian.deleteMany()
  await prisma.user.deleteMany()
  for (const tgId of [READER, READER2, OWNER, STRANGER]) {
    await prisma.user.create({ data: { tgId, firstName: `Имя${tgId % 100n}` } })
  }
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

/** Книга на полке владельца; по умолчанию её уже вернул READER. */
async function seedBook(opts: { title?: string; author?: string | null; read?: boolean } = {}) {
  const librarian = await prisma.librarian.create({ data: { name: 'Владелец', tgId: OWNER } })
  const book = await prisma.book.create({
    data: {
      title: opts.title ?? 'Мастер и Маргарита',
      author: opts.author === undefined ? 'Булгаков' : opts.author,
      kind: 'book',
      active: true,
      reviewStatus: 'approved',
      ownerId: librarian.id,
    },
  })
  if (opts.read !== false) {
    await prisma.loan.create({
      data: {
        title: book.title,
        bookId: book.id,
        ownerTg: OWNER,
        holderTg: READER,
        status: 'returned',
        returnedAt: new Date(),
      },
    })
  }
  return book
}

test('право оценивать: закрытая выдача даёт, отсутствие выдачи — нет', async () => {
  const book = await seedBook()
  const key = workKeyOf(book)
  assert.equal(await canReview(READER, key), true)
  assert.equal(await canReview(STRANGER, key), false)
})

test('активная выдача ещё не даёт права: книга не дочитана и не вернулась', async () => {
  const book = await seedBook({ read: false })
  await prisma.loan.create({
    data: {
      title: book.title,
      bookId: book.id,
      activeBookId: book.id,
      ownerTg: OWNER,
      holderTg: READER,
      status: 'active',
    },
  })
  assert.equal(await canReview(READER, workKeyOf(book)), false)
})

test('владелец экземпляра может оценить свою книгу', async () => {
  const book = await seedBook({ read: false })
  assert.equal(await canReview(OWNER, workKeyOf(book)), true)
})

test('оценка вешается на произведение: второй экземпляр той же книги показывает ту же среднюю', async () => {
  const first = await seedBook()
  const other = await prisma.librarian.create({ data: { name: 'Другой библиотекарь' } })
  const second = await prisma.book.create({
    data: {
      title: 'мастер  и   Маргарита', // регистр и пробелы нормализуются
      author: 'Булгаков',
      kind: 'book',
      active: true,
      reviewStatus: 'approved',
      ownerId: other.id,
    },
  })

  await upsertReview({ authorTg: READER, book: first, rating: 5, text: null })

  const r = await app.inject({ method: 'GET', url: `/api/books/${second.id}/reviews` })
  assert.equal(r.statusCode, 200)
  const body = r.json()
  assert.equal(body.rating.avg, 5)
  assert.equal(body.rating.count, 1)
})

test('повторная оценка обновляет свою, а не плодит вторую', async () => {
  const book = await seedBook()
  await upsertReview({ authorTg: READER, book, rating: 2, text: 'Не пошло' })
  await upsertReview({ authorTg: READER, book, rating: 4, text: 'Перечитал, лучше' })

  const rows = await prisma.review.findMany({ where: { workKey: workKeyOf(book) } })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].rating, 4)
  const rating = await ratingFor(workKeyOf(book))
  assert.deepEqual(rating, { avg: 4, count: 1 })
})

test('средняя считается по всем оценкам и переживает удаление одной', async () => {
  const book = await seedBook()
  await prisma.loan.create({
    data: {
      title: book.title,
      bookId: book.id,
      ownerTg: OWNER,
      holderTg: READER2,
      status: 'returned',
      returnedAt: new Date(),
    },
  })
  await upsertReview({ authorTg: READER, book, rating: 5, text: null })
  await upsertReview({ authorTg: READER2, book, rating: 4, text: null })
  assert.deepEqual(await ratingFor(workKeyOf(book)), { avg: 4.5, count: 2 })

  const del = await deleteReview(READER2, workKeyOf(book))
  assert.equal(del.deleted, true)
  assert.deepEqual(await ratingFor(workKeyOf(book)), { avg: 5, count: 1 })

  await deleteReview(READER, workKeyOf(book))
  assert.deepEqual(await ratingFor(workKeyOf(book)), { avg: null, count: 0 })
  assert.equal(await prisma.workRating.count(), 0, 'пустой агрегат не остаётся висеть')
})

test('POST без прочтения — 403 not_read, отзыв не появляется', async () => {
  const book = await seedBook()
  const r = await app.inject({
    method: 'POST',
    url: `/api/books/${book.id}/review`,
    headers: asUser(STRANGER),
    payload: { rating: 5, text: 'Отличная книга' },
  })
  assert.equal(r.statusCode, 403)
  assert.equal(r.json().error, 'not_read')
  assert.equal(await prisma.review.count(), 0)
})

test('POST читавшего — 200, оценка и текст сохраняются', async () => {
  const book = await seedBook()
  const r = await app.inject({
    method: 'POST',
    url: `/api/books/${book.id}/review`,
    headers: asUser(READER),
    payload: { rating: 5, text: 'Перечитывала трижды' },
  })
  assert.equal(r.statusCode, 200)
  const body = r.json()
  assert.equal(body.rating.avg, 5)
  assert.equal(body.items[0].text, 'Перечитывала трижды')
  assert.equal(body.items[0].mine, true)
})

test('валидация: оценка вне 1..5, слишком длинный текст и ссылки не проходят', async () => {
  assert.throws(() => validateReview({ rating: 0 }), /bad_rating/)
  assert.throws(() => validateReview({ rating: 6 }), /bad_rating/)
  assert.throws(() => validateReview({ rating: 3.5 }), /bad_rating/)
  assert.throws(() => validateReview({ rating: 'пять' }), /bad_rating/)
  assert.throws(
    () => validateReview({ rating: 5, text: 'а'.repeat(REVIEW_TEXT_MAX + 1) }),
    /text_too_long/,
  )
  assert.throws(
    () => validateReview({ rating: 5, text: 'читайте на http://spam.example' }),
    /links_not_allowed/,
  )
  assert.throws(() => validateReview({ rating: 5, text: 'скидки тут t.me/spam' }), /links_not_allowed/)
  // пустой текст — это просто оценка без слов, а не ошибка
  assert.deepEqual(validateReview({ rating: 4, text: '   ' }), { rating: 4, text: null })
})

test('мусор в теле запроса — 400, а не 500', async () => {
  const book = await seedBook()
  const r = await app.inject({
    method: 'POST',
    url: `/api/books/${book.id}/review`,
    headers: asUser(READER),
    payload: { rating: 99 },
  })
  assert.equal(r.statusCode, 400)
  assert.equal(r.json().error, 'bad_rating')
})

test('жалобы: три штуки прячут отзыв и убирают его из средней', async () => {
  const book = await seedBook()
  const { review } = await upsertReview({ authorTg: READER, book, rating: 1, text: 'спам' })
  await prisma.loan.create({
    data: {
      title: book.title,
      bookId: book.id,
      ownerTg: OWNER,
      holderTg: READER2,
      status: 'returned',
      returnedAt: new Date(),
    },
  })
  await upsertReview({ authorTg: READER2, book, rating: 5, text: null })
  assert.deepEqual(await ratingFor(workKeyOf(book)), { avg: 3, count: 2 })

  assert.deepEqual(await reportReview(review.id, OWNER), { hidden: false, reports: 1 })
  assert.deepEqual(await reportReview(review.id, READER2), { hidden: false, reports: 2 })
  assert.deepEqual(await reportReview(review.id, STRANGER), { hidden: true, reports: 3 })

  assert.deepEqual(await ratingFor(workKeyOf(book)), { avg: 5, count: 1 })
  const visible = await listReviews(workKeyOf(book))
  assert.equal(visible.length, 1)
})

test('на свой отзыв пожаловаться нельзя', async () => {
  const book = await seedBook()
  const { review } = await upsertReview({ authorTg: READER, book, rating: 3, text: null })
  assert.deepEqual(await reportReview(review.id, READER), { error: 'own_review' })
})

test('правка своего отзыва снимает жалобы и возвращает его людям', async () => {
  const book = await seedBook()
  const { review } = await upsertReview({ authorTg: READER, book, rating: 1, text: 'первый текст' })
  await reportReview(review.id, OWNER)
  await reportReview(review.id, READER2)
  await reportReview(review.id, STRANGER)
  assert.equal((await listReviews(workKeyOf(book))).length, 0)

  await upsertReview({ authorTg: READER, book, rating: 4, text: 'переписал по-человечески' })
  const visible = await listReviews(workKeyOf(book))
  assert.equal(visible.length, 1)
  assert.equal(visible[0].rating, 4)
  assert.deepEqual(await ratingFor(workKeyOf(book)), { avg: 4, count: 1 })
})

test('в ответе нет ни tgId, ни ника: отзыв не повод раскрывать контакты', async () => {
  const book = await seedBook()
  await prisma.user.update({ where: { tgId: READER }, data: { username: 'secret_handle' } })
  await upsertReview({ authorTg: READER, book, rating: 5, text: 'хорошая' })

  const r = await app.inject({ method: 'GET', url: `/api/books/${book.id}/reviews` })
  const raw = r.body
  assert.equal(raw.includes('secret_handle'), false, 'ник читателя не должен уезжать клиенту')
  assert.equal(raw.includes(String(READER)), false, 'числовой tgId клиенту не нужен')
  assert.equal(r.json().items[0].authorName.length > 0, true)
})

test('без подписи Telegram: отзывы читаются, но право оценивать не даётся', async () => {
  const book = await seedBook()
  await upsertReview({ authorTg: READER, book, rating: 5, text: 'видно всем' })
  const r = await app.inject({ method: 'GET', url: `/api/books/${book.id}/reviews` })
  assert.equal(r.statusCode, 200)
  const body = r.json()
  assert.equal(body.items.length, 1)
  assert.equal(body.canReview, false)
  assert.equal(body.signed, false, 'без подписи кнопка жалобы фронту не нужна')
  assert.equal(body.myReview, null)
  assert.equal(body.items[0].mine, false)

  const signed = await app.inject({
    method: 'GET',
    url: `/api/books/${book.id}/reviews`,
    headers: asUser(STRANGER),
  })
  assert.equal(signed.json().signed, true)
})

test('оценка книги попадает в карточку каталога и в разворот книги', async () => {
  const book = await seedBook()
  await upsertReview({ authorTg: READER, book, rating: 4, text: null })

  const card = await app.inject({ method: 'GET', url: `/api/books/${book.id}` })
  assert.deepEqual(card.json().rating, { avg: 4, count: 1 })

  const list = await app.inject({ method: 'GET', url: '/api/books?limit=10' })
  const found = list.json().items.find((b: any) => b.id === book.id)
  assert.deepEqual(found.rating, { avg: 4, count: 1 })
})

test('удалить чужую оценку нельзя: удаляется только своя', async () => {
  const book = await seedBook()
  await upsertReview({ authorTg: READER, book, rating: 5, text: null })
  const r = await app.inject({
    method: 'DELETE',
    url: `/api/books/${book.id}/review`,
    headers: asUser(STRANGER),
  })
  assert.equal(r.statusCode, 404)
  assert.equal(await prisma.review.count(), 1)
})

test('выдача без карточки книги: право появляется по названию', async () => {
  await prisma.loan.create({
    data: { title: 'Тень горы', ownerTg: OWNER, holderTg: READER, status: 'returned', returnedAt: new Date() },
  })
  assert.equal(await canReview(READER, workKeyOf({ title: 'Тень горы' })), true)
  assert.equal(await canReview(READER, workKeyOf({ title: 'Другая книга' })), false)
})
