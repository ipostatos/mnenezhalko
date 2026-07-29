/**
 * Решения по книгам с админского ЭКРАНА (`/api/admin/books/:id/decide`) и
 * очередь разбора, из которой этот экран рисуется.
 *
 * Проверяется то, что отличает экран от кнопок в боте: сюда приходит обычный
 * HTTP-запрос, а значит нужны подпись Telegram и проверка прав; решение должно
 * идти ТЕМ ЖЕ идемпотентным путём (повторное «одобрить» не пишет второе решение
 * в журнал и не отправляет человеку второе письмо); отклонение без причины не
 * принимается; письмо человеку кладётся в очередь, а не отправляется на удачу.
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

const DB_FILE = join(tmpdir(), `admin-books-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'
process.env.BOT_TOKEN = '123456:test-token-for-signature'
process.env.NOTION_TOKEN_V2 = '' // запись в общую таблицу выключена — сеть не трогаем
const ADMIN = 991001n
process.env.ADMIN_IDS = String(ADMIN)

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { registerRoutes } = await import('./routes.js')
const { flushNotices, moderationQueue, setModerationNoticeSender } = await import(
  './moderation.js'
)
const { bookDecisionNotice } = await import('./publish.js')

const PERSON = 991010n // тот, кто книгу принёс
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

const decide = (id: string, body: Record<string, string>, tgId: bigint | null = ADMIN) =>
  app.inject({
    method: 'POST',
    url: `/api/admin/books/${id}/decide`,
    headers: tgId === null ? {} : asUser(tgId),
    payload: body,
  })

before(async () => {
  await registerRoutes(app)
  await app.ready()
})

beforeEach(async () => {
  await prisma.notificationOutbox.deleteMany()
  await prisma.moderationAction.deleteMany()
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

async function seedPending(overrides: Record<string, unknown> = {}) {
  const owner = await prisma.librarian.create({ data: { name: 'Ирина', city: 'Warszawa' } })
  return prisma.book.create({
    data: {
      title: 'Книга на проверке',
      author: 'Автор',
      kind: 'book',
      source: 'bot',
      city: 'Warszawa',
      genres: 'Фантастика',
      languages: 'Русский',
      active: true,
      reviewStatus: 'pending',
      submittedAt: new Date(),
      ownerId: owner.id,
      addedByTg: PERSON,
      ...overrides,
    },
  })
}

/* ── права ────────────────────────────────────────────────── */

test('без подписи Telegram решение не принимается', async () => {
  const b = await seedPending()
  const res = await decide(b.id, { decision: 'approve' }, null)
  assert.equal(res.statusCode, 401)
  const fresh = await prisma.book.findUniqueOrThrow({ where: { id: b.id } })
  assert.equal(fresh.reviewStatus, 'pending', 'книга не тронута')
})

test('обычный участник получает 403, а не решение', async () => {
  const b = await seedPending()
  const res = await decide(b.id, { decision: 'approve' }, PERSON)
  assert.equal(res.statusCode, 403)
  const fresh = await prisma.book.findUniqueOrThrow({ where: { id: b.id } })
  assert.equal(fresh.reviewStatus, 'pending')
  assert.equal(await prisma.moderationAction.count(), 0, 'в журнале ничего нет')
})

test('очередь разбора закрыта от посторонних', async () => {
  const anon = await app.inject({ method: 'GET', url: '/api/admin/moderation' })
  assert.equal(anon.statusCode, 401)
  const person = await app.inject({
    method: 'GET',
    url: '/api/admin/moderation',
    headers: asUser(PERSON),
  })
  assert.equal(person.statusCode, 403)
})

/* ── одобрение ────────────────────────────────────────────── */

test('одобрение с экрана: книга в каталоге, решение в журнале, письмо в очереди', async () => {
  const b = await seedPending()
  const res = await decide(b.id, { decision: 'approve' })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.already, false)
  assert.equal(body.card.title, 'Книга на проверке')

  const fresh = await prisma.book.findUniqueOrThrow({ where: { id: b.id } })
  assert.equal(fresh.reviewStatus, 'approved')
  assert.equal(fresh.reviewedByTg, ADMIN, 'видно, КТО решил')

  const log = await prisma.moderationAction.findMany()
  assert.equal(log.length, 1)
  assert.equal(log[0].action, 'approve')
  assert.equal(log[0].targetType, 'book')
  assert.equal(log[0].targetId, b.id)
  assert.equal(log[0].actorTg, ADMIN)

  const mail = await prisma.notificationOutbox.findMany()
  assert.equal(mail.length, 1, 'письмо лежит в очереди, а не отправлено на удачу')
  assert.equal(mail[0].recipientTg, PERSON)
  assert.equal(mail[0].payload, bookDecisionNotice('approve', 'Книга на проверке'))
})

test('повторное «одобрить»: второго решения и второго письма нет', async () => {
  const b = await seedPending()
  await decide(b.id, { decision: 'approve' })
  const again = await decide(b.id, { decision: 'approve' })
  assert.equal(again.statusCode, 200)
  assert.equal(again.json().already, true, 'экран честно говорит, что уже решено')
  assert.equal(await prisma.moderationAction.count(), 1, 'журнал не задваивается')
  assert.equal(await prisma.notificationOutbox.count(), 1, 'человеку не пишем дважды')
})

test('одобрить отклонённую нельзя — только отправкой заново', async () => {
  const b = await seedPending({ reviewStatus: 'rejected', rejectionReason: 'не та книга' })
  const res = await decide(b.id, { decision: 'approve' })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().error, 'rejected')
})

test('книгу, которую прямо сейчас одобряет другой админ, экран не выдёргивает', async () => {
  const b = await seedPending({ reviewStatus: 'approving', approvalStartedAt: new Date() })
  const res = await decide(b.id, { decision: 'approve' })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().error, 'in_progress')
})

test('несуществующая книга — 404, а не 500', async () => {
  const res = await decide(randomUUID(), { decision: 'approve' })
  assert.equal(res.statusCode, 404)
})

/* ── отклонение ───────────────────────────────────────────── */

test('отклонение без причины не принимается: человеку нечего было бы ответить', async () => {
  const b = await seedPending()
  const res = await decide(b.id, { decision: 'reject' })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, 'no_reason')
  const fresh = await prisma.book.findUniqueOrThrow({ where: { id: b.id } })
  assert.equal(fresh.reviewStatus, 'pending', 'книга осталась в очереди')
  assert.equal(await prisma.notificationOutbox.count(), 0)
})

test('отклонение с причиной: причина видна и владельцу, и в письме', async () => {
  const b = await seedPending()
  const res = await decide(b.id, { decision: 'reject', reason: 'фото не читается' })
  assert.equal(res.statusCode, 200)

  const fresh = await prisma.book.findUniqueOrThrow({ where: { id: b.id } })
  assert.equal(fresh.reviewStatus, 'rejected')
  assert.equal(fresh.rejectionReason, 'фото не читается', 'причину видно на «Моей полке»')

  const log = await prisma.moderationAction.findMany()
  assert.equal(log.length, 1)
  assert.equal(log[0].action, 'reject')
  assert.equal(log[0].reason, 'фото не читается')

  const mail = await prisma.notificationOutbox.findMany()
  assert.equal(mail.length, 1)
  assert.match(mail[0].payload, /фото не читается/)
  assert.match(mail[0].payload, /отправить снова/, 'человеку сказано, что делать дальше')
})

test('мусор вместо решения — 400, книга не тронута', async () => {
  const b = await seedPending()
  const res = await decide(b.id, { decision: 'удалить-всё' })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, 'bad_decision')
  const fresh = await prisma.book.findUniqueOrThrow({ where: { id: b.id } })
  assert.equal(fresh.reviewStatus, 'pending')
})

/* ── очередь для экрана ───────────────────────────────────── */

test('очередь отдаёт КАРТОЧКИ книг: экрану нужно видеть, что проверять', async () => {
  await seedPending()
  await seedPending({ title: 'Вторая книга' })
  const res = await app.inject({
    method: 'GET',
    url: '/api/admin/moderation',
    headers: asUser(ADMIN),
  })
  assert.equal(res.statusCode, 200)
  const q = res.json()
  assert.equal(q.pendingBooksCount, 2)
  assert.equal(q.pendingBooks.length, 2)
  const first = q.pendingBooks[0]
  assert.ok(first.title, 'название')
  assert.equal(first.ownerName, 'Ирина', 'чья книга')
  assert.equal(first.city, 'Warszawa')
  assert.deepEqual(first.genres, ['Фантастика'], 'жанры разобраны в список')
  assert.ok(first.submittedAt, 'когда отправлена — видно, сколько ждёт')
})

test('обложка в очереди идёт через конвейер превью, а не сырой ссылкой', async () => {
  await seedPending({ coverUrl: 'https://example.com/cover.jpg' })
  const q = await moderationQueue()
  const cover = q.pendingBooks[0].coverUrl
  assert.ok(cover, 'обложка есть')
  assert.match(cover!, /^\/api\/img\?/, 'через прокси: ресайз, кэш и проверка адреса')
  assert.match(cover!, /&s=/, 'ссылка подписана')
})

test('одобренная книга уходит из очереди сама', async () => {
  const b = await seedPending()
  await decide(b.id, { decision: 'approve' })
  const q = await moderationQueue()
  assert.equal(q.pendingBooksCount, 0)
})

test('недоставленные письма видны в очереди числом', async () => {
  await prisma.notificationOutbox.create({
    data: { recipientTg: PERSON, kind: 'moderation', payload: 'тест', attempts: 4 },
  })
  await prisma.notificationOutbox.create({
    data: { recipientTg: PERSON, kind: 'moderation', payload: 'свежее', attempts: 0 },
  })
  const q = await moderationQueue()
  assert.equal(q.stuckNotices, 1, 'считаем только застрявшие, а не всю очередь')
})

/* ── доставка писем ───────────────────────────────────────── */

test('письмо, исчезнувшее пока его отправляли, не роняет рассылку', async () => {
  // человек удалил профиль ровно в этот момент — его неотправленные письма
  // удаляются вместе с остальными данными (mydata.ts)
  const gone = await prisma.notificationOutbox.create({
    data: { recipientTg: PERSON, kind: 'moderation', payload: 'решение по книге' },
  })
  const alive = await prisma.notificationOutbox.create({
    data: { recipientTg: ADMIN, kind: 'moderation', payload: 'второе письмо' },
  })
  const seen: bigint[] = []
  setModerationNoticeSender(async (to) => {
    seen.push(to)
    if (to === PERSON) await prisma.notificationOutbox.delete({ where: { id: gone.id } })
  })
  try {
    const res = await flushNotices()
    assert.equal(res.sent, 2, 'оба письма отправлены')
    assert.deepEqual(seen, [PERSON, ADMIN], 'второе письмо не потерялось из-за первого')
    const left = await prisma.notificationOutbox.findUnique({ where: { id: alive.id } })
    assert.ok(left?.sentAt, 'живое письмо отмечено отправленным')
  } finally {
    setModerationNoticeSender(async () => {})
  }
})

test('в ограничениях и решениях видно ИМЯ человека, а не только номер', async () => {
  await prisma.user.create({
    data: { tgId: PERSON, username: 'reader', firstName: 'Пётр' },
  })
  await prisma.userRestriction.create({
    data: { userTg: PERSON, scope: 'reviews', reason: 'ругань', createdByTg: ADMIN },
  })
  const q = await moderationQueue()
  assert.equal(q.restrictions.length, 1)
  assert.equal(q.restrictions[0].name, 'Пётр')
  assert.equal(q.restrictions[0].username, 'reader')
})
