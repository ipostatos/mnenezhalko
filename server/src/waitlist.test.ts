/**
 * Очередь на занятую книгу (issue #10). Проверяется то, за что фича и обещает
 * отвечать: порядок, одно уведомление вместо десяти, приватность соседей по
 * очереди и то, что обещание переживает падение процесса.
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

const DB_FILE = join(tmpdir(), `waitlist-test-${randomUUID()}.db`)
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
const { markReturned, reopenLoan } = await import('./loans.js')
const {
  MAX_WAITING_PER_USER,
  escalateStale,
  expireWaitings,
  joinWaitlist,
  leaveWaitlist,
  myWaitings,
  noticeText,
  runWaitlistNotices,
  waitCountsFor,
  waitlistFor,
} = await import('./waitlist.js')

const OWNER = 810001n
const HOLDER = 810002n
const ANNA = 810003n
const BORIS = 810004n
const VERA = 810005n

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
  await prisma.waiting.deleteMany()
  await prisma.loanEvent.deleteMany()
  await prisma.loan.deleteMany()
  await prisma.book.deleteMany()
  await prisma.librarian.deleteMany()
  await prisma.user.deleteMany()
  for (const tgId of [OWNER, HOLDER, ANNA, BORIS, VERA]) {
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

/** Книга на полке владельца, по умолчанию выданная HOLDER (то есть занятая). */
async function seedBusyBook(opts: { busy?: boolean; title?: string } = {}) {
  // владелец один на весь тест: несколько книг на одной полке — обычное дело,
  // а tgId у библиотекаря уникален
  const librarian = await prisma.librarian.upsert({
    where: { tgId: OWNER },
    create: { name: 'Владелец', tgId: OWNER, telegram: 'owner', city: 'Warszawa' },
    update: {},
  })
  const busy = opts.busy !== false
  const book = await prisma.book.create({
    data: {
      title: opts.title ?? 'Дюна',
      author: 'Герберт',
      kind: 'book',
      active: true,
      reviewStatus: 'approved',
      status: busy ? 'busy' : 'free',
      city: 'Warszawa',
      ownerId: librarian.id,
    },
  })
  const loan = busy
    ? await prisma.loan.create({
        data: {
          title: book.title,
          bookId: book.id,
          activeBookId: book.id,
          ownerTg: OWNER,
          holderTg: HOLDER,
          status: 'active',
        },
      })
    : null
  return { book, loan, librarian }
}

test('встать в очередь можно только на занятую книгу', async () => {
  const { book } = await seedBusyBook({ busy: false })
  const r = await joinWaitlist(ANNA, book.id)
  assert.deepEqual(r, { ok: false, error: 'not_busy' })
})

test('свою книгу ждать незачем', async () => {
  const { book } = await seedBusyBook()
  assert.deepEqual(await joinWaitlist(OWNER, book.id), { ok: false, error: 'own_book' })
})

test('снятую с полки книгу ждать нельзя', async () => {
  const { book } = await seedBusyBook()
  await prisma.book.update({ where: { id: book.id }, data: { active: false } })
  assert.deepEqual(await joinWaitlist(ANNA, book.id), { ok: false, error: 'book_unavailable' })
})

test('очередь держит порядок, повторное нажатие не плодит вторую запись', async () => {
  const { book } = await seedBusyBook()
  const a = await joinWaitlist(ANNA, book.id, new Date('2026-07-29T10:00:00Z'))
  const b = await joinWaitlist(BORIS, book.id, new Date('2026-07-29T10:01:00Z'))
  assert.deepEqual(a, { ok: true, position: 1, count: 1 })
  assert.deepEqual(b, { ok: true, position: 2, count: 2 })

  // повторное нажатие тем же человеком: место то же, очередь не выросла
  const again = await joinWaitlist(ANNA, book.id, new Date('2026-07-29T10:02:00Z'))
  assert.equal(again.ok && again.count, 2)
  assert.equal(await prisma.waiting.count({ where: { bookId: book.id } }), 2)
})

test('нельзя ждать бесконечное число книг', async () => {
  const books = []
  for (let i = 0; i <= MAX_WAITING_PER_USER; i++) {
    const { book } = await seedBusyBook({ title: `Книга ${i}` })
    books.push(book)
  }
  for (let i = 0; i < MAX_WAITING_PER_USER; i++) {
    assert.equal((await joinWaitlist(ANNA, books[i].id)).ok, true, `книга ${i}`)
  }
  assert.deepEqual(await joinWaitlist(ANNA, books[MAX_WAITING_PER_USER].id), {
    ok: false,
    error: 'too_many',
  })
})

test('ждущие не видят друг друга: наружу уходит только число и своё место', async () => {
  const { book } = await seedBusyBook()
  await joinWaitlist(ANNA, book.id, new Date('2026-07-29T10:00:00Z'))
  await joinWaitlist(BORIS, book.id, new Date('2026-07-29T10:01:00Z'))

  const forAnna = await waitlistFor(book.id, ANNA)
  assert.deepEqual(
    { count: forAnna.count, position: forAnna.mine?.position },
    { count: 2, position: 1 },
  )
  // аноним видит только число
  assert.deepEqual(await waitlistFor(book.id, null), { count: 2, mine: null })

  // и в ответе ручки нет ни ников, ни числовых id ждущих
  const res = await app.inject({
    method: 'GET',
    url: `/api/books/${book.id}`,
    headers: asUser(BORIS),
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.deepEqual(body.waiting.count, 2)
  assert.deepEqual(body.waiting.mine.position, 2)
  const raw = res.body
  for (const tg of [ANNA, BORIS, VERA]) {
    assert.ok(!raw.includes(String(tg)), `в ответе не должно быть tgId ${tg}`)
  }
})

test('возврат книги зовёт ПЕРВОГО в очереди и только его', async () => {
  const { book, loan } = await seedBusyBook()
  await joinWaitlist(ANNA, book.id, new Date('2026-07-29T10:00:00Z'))
  await joinWaitlist(BORIS, book.id, new Date('2026-07-29T10:01:00Z'))

  await markReturned(loan!.id, OWNER)

  const rows = await prisma.waiting.findMany({ where: { bookId: book.id }, orderBy: { createdAt: 'asc' } })
  assert.deepEqual(
    rows.map((r) => [r.userTg, r.status]),
    [
      [ANNA, 'ready'],
      [BORIS, 'waiting'],
    ],
  )
})

test('обещание переживает рестарт: ready лежит в базе и рассылается позже', async () => {
  const { book, loan } = await seedBusyBook()
  await joinWaitlist(ANNA, book.id)
  await markReturned(loan!.id, OWNER)

  // «процесс упал сразу после возврата»: сообщение никто не отправлял
  assert.equal(await prisma.waiting.count({ where: { status: 'ready', notifiedAt: null } }), 1)

  const sent: { chatId: string; text: string }[] = []
  const r = await runWaitlistNotices({
    send: async (chatId, text) => void sent.push({ chatId, text }),
  })
  assert.deepEqual({ pending: r.pending, sent: r.sent, failed: r.failed }, { pending: 1, sent: 1, failed: 0 })
  assert.equal(sent[0].chatId, String(ANNA))
  assert.ok(sent[0].text.includes('Дюна'), 'в письме есть название книги')

  // повторный прогон джобы ничего не задваивает
  const again = await runWaitlistNotices({ send: async () => void sent.push({ chatId: 'x', text: 'x' }) })
  assert.deepEqual({ pending: again.pending, sent: again.sent }, { pending: 0, sent: 0 })
  assert.equal(sent.length, 1)
})

test('заблокировавший бота не держит очередь вечно: после трёх неудач запись закрывается', async () => {
  const { book, loan } = await seedBusyBook()
  await joinWaitlist(ANNA, book.id)
  await markReturned(loan!.id, OWNER)

  const failing = { send: async () => { throw new Error('bot was blocked by the user') } }
  for (let i = 0; i < 3; i++) await runWaitlistNotices(failing)

  const row = await prisma.waiting.findFirst({ where: { bookId: book.id } })
  assert.equal(row?.status, 'left')
  // четвёртый прогон уже никого не находит
  assert.equal((await runWaitlistNotices(failing)).pending, 0)
})

test('отмена возврата возвращает неотправленное обещание в очередь', async () => {
  const { book, loan } = await seedBusyBook()
  await joinWaitlist(ANNA, book.id)
  await markReturned(loan!.id, OWNER)
  assert.equal((await prisma.waiting.findFirst())?.status, 'ready')

  const r = await reopenLoan(loan!.id, OWNER)
  assert.ok('loan' in r, 'возврат отменён')
  const row = await prisma.waiting.findFirst()
  assert.deepEqual([row?.status, row?.readyAt], ['waiting', null])
})

test('уже отправленное обещание отмена возврата не отзывает', async () => {
  const { book, loan } = await seedBusyBook()
  await joinWaitlist(ANNA, book.id)
  await markReturned(loan!.id, OWNER)
  await runWaitlistNotices({ send: async () => {} })

  await reopenLoan(loan!.id, OWNER)
  assert.equal((await prisma.waiting.findFirst())?.status, 'notified')
})

test('книга, скрытая владельцем после возврата, закрывает очередь молча', async () => {
  const { book, loan } = await seedBusyBook()
  await prisma.book.update({ where: { id: book.id }, data: { hideAfterReturn: true } })
  await joinWaitlist(ANNA, book.id)

  await markReturned(loan!.id, OWNER)

  assert.equal((await prisma.waiting.findFirst())?.status, 'left')
  assert.equal((await runWaitlistNotices({ send: async () => {} })).pending, 0)
})

test('протухшая очередь не уведомляется и не считается', async () => {
  const { book, loan } = await seedBusyBook()
  await joinWaitlist(ANNA, book.id)
  await prisma.waiting.updateMany({ data: { expiresAt: new Date('2026-01-01T00:00:00Z') } })

  assert.deepEqual(await waitlistFor(book.id, ANNA), { count: 0, mine: null })
  assert.equal(await expireWaitings(), 1)
  await markReturned(loan!.id, OWNER)
  assert.equal((await runWaitlistNotices({ send: async () => {} })).pending, 0)
})

test('первый не пришёл — через сутки очередь переходит к следующему', async () => {
  const { book, loan } = await seedBusyBook()
  await joinWaitlist(ANNA, book.id, new Date('2026-07-29T10:00:00Z'))
  await joinWaitlist(BORIS, book.id, new Date('2026-07-29T10:01:00Z'))
  await markReturned(loan!.id, OWNER)
  await runWaitlistNotices({ send: async () => {}, now: new Date('2026-07-29T12:00:00Z') })

  // через час ещё рано
  assert.deepEqual(await escalateStale(new Date('2026-07-29T13:00:00Z')), { checked: 0, moved: 0 })

  const r = await escalateStale(new Date('2026-07-30T13:00:00Z'))
  assert.deepEqual(r, { checked: 1, moved: 1 })
  const rows = await prisma.waiting.findMany({ orderBy: { createdAt: 'asc' } })
  assert.deepEqual(
    rows.map((x) => [x.userTg, x.status]),
    [
      [ANNA, 'left'],
      [BORIS, 'ready'],
    ],
  )
})

test('пока книгу не вернули, эскалация никого не трогает', async () => {
  const { book, loan } = await seedBusyBook()
  await joinWaitlist(ANNA, book.id)
  await joinWaitlist(BORIS, book.id)
  await markReturned(loan!.id, OWNER)
  await runWaitlistNotices({ send: async () => {}, now: new Date('2026-07-29T12:00:00Z') })
  // книгу тут же взял кто-то ещё
  await prisma.book.update({ where: { id: book.id }, data: { status: 'busy' } })

  assert.deepEqual(await escalateStale(new Date('2026-07-31T13:00:00Z')), { checked: 0, moved: 0 })
})

test('ручки очереди: без подписи 401, вставание и выход через API', async () => {
  const { book } = await seedBusyBook()
  const anon = await app.inject({ method: 'POST', url: `/api/books/${book.id}/wait` })
  assert.equal(anon.statusCode, 401)

  const join = await app.inject({
    method: 'POST',
    url: `/api/books/${book.id}/wait`,
    headers: asUser(ANNA, 'Аня'),
  })
  assert.equal(join.statusCode, 200)
  assert.deepEqual(join.json().waiting.mine.position, 1)

  const own = await app.inject({
    method: 'POST',
    url: `/api/books/${book.id}/wait`,
    headers: asUser(OWNER, 'Владелец'),
  })
  assert.equal(own.statusCode, 409)
  assert.equal(own.json().error, 'own_book')

  const leave = await app.inject({
    method: 'DELETE',
    url: `/api/books/${book.id}/wait`,
    headers: asUser(ANNA, 'Аня'),
  })
  assert.equal(leave.statusCode, 200)
  assert.deepEqual(leave.json().waiting, { count: 0, mine: null })
})

test('вернувшийся в очередь встаёт в конец, а не остаётся первым', async () => {
  const { book, loan } = await seedBusyBook()
  await joinWaitlist(ANNA, book.id, new Date('2026-07-29T10:00:00Z'))
  await joinWaitlist(BORIS, book.id, new Date('2026-07-29T10:01:00Z'))
  await markReturned(loan!.id, OWNER)
  await runWaitlistNotices({ send: async () => {} })
  // Аню позвали, книгу она не забрала и встала снова, когда книгу выдали дальше
  await prisma.book.update({ where: { id: book.id }, data: { status: 'busy' } })

  const again = await joinWaitlist(ANNA, book.id, new Date('2026-07-31T10:00:00Z'))
  assert.deepEqual(again, { ok: true, position: 2, count: 2 })
})

test('владельцу видно число ждущих по каждой книге', async () => {
  const first = await seedBusyBook({ title: 'Дюна' })
  const second = await seedBusyBook({ title: 'Солярис' })
  await joinWaitlist(ANNA, first.book.id)
  await joinWaitlist(BORIS, first.book.id)
  await joinWaitlist(VERA, second.book.id)

  const counts = await waitCountsFor([first.book.id, second.book.id])
  assert.deepEqual([counts.get(first.book.id), counts.get(second.book.id)], [2, 1])

  const shelf = await app.inject({
    method: 'GET',
    url: '/api/my-shelf',
    headers: asUser(OWNER, 'Владелец'),
  })
  assert.equal(shelf.statusCode, 200)
  const byTitle = new Map(shelf.json().books.map((b: any) => [b.title, b.waitCount]))
  assert.deepEqual([byTitle.get('Дюна'), byTitle.get('Солярис')], [2, 1])
})

test('человек видит, где стоит в очереди', async () => {
  const first = await seedBusyBook({ title: 'Дюна' })
  const second = await seedBusyBook({ title: 'Солярис' })
  await joinWaitlist(ANNA, first.book.id)
  await joinWaitlist(ANNA, second.book.id)
  await leaveWaitlist(ANNA, second.book.id)

  const mine = await myWaitings(ANNA)
  assert.deepEqual(
    mine.map((w) => w.book.title),
    ['Дюна'],
  )
})

test('в письме есть название, владелец и город — человеку хватает, чтобы ответить', () => {
  const text = noticeText({
    id: 'x',
    userTg: ANNA,
    attempts: 0,
    book: { id: 'b', title: 'Дюна', author: 'Герберт', city: 'Warszawa' },
    ownerName: 'Владелец',
    ownerTelegram: 'owner',
  })
  for (const part of ['Дюна', 'Герберт', '@owner', 'Warszawa']) {
    assert.ok(text.includes(part), `в письме нет «${part}»`)
  }
})
