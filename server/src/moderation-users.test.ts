/**
 * Ограничения участников и решения модераторов.
 *
 * Проверяется ровно то, что перечислено в критериях приёмки: точечность
 * (закрытые отзывы не мешают вернуть чужую книгу), идемпотентность (повторное
 * нажатие ничего не удваивает), защита от выстрела в ногу (себя и админа не
 * заблокировать), обязательность причины, автоматическое истечение срока,
 * запись КАЖДОГО решения в неизменяемый журнал и то, что заблокированный
 * человек всё ещё может забрать и удалить свои данные.
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

const DB_FILE = join(tmpdir(), `moderation-users-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'
process.env.BOT_TOKEN = '123456:test-token-for-signature'
process.env.NOTION_TOKEN_V2 = ''
const ADMIN = 990001n
const OTHER_ADMIN = 990002n
process.env.ADMIN_IDS = `${ADMIN},${OTHER_ADMIN}`

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { registerRoutes } = await import('./routes.js')
const {
  activeRestrictions,
  banUser,
  checkUserCan,
  decideReview,
  explainVerdict,
  moderationQueue,
  restrictUser,
  unbanUser,
  unrestrictUser,
} = await import('./moderation.js')

const PERSON = 990010n
const FRIEND = 990011n

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

before(async () => {
  await registerRoutes(app)
  await app.ready()
})

beforeEach(async () => {
  await prisma.moderationAction.deleteMany()
  await prisma.userRestriction.deleteMany()
  await prisma.reviewReport.deleteMany()
  await prisma.review.deleteMany()
  await prisma.workRating.deleteMany()
  await prisma.waiting.deleteMany()
  await prisma.loanEvent.deleteMany()
  await prisma.loan.deleteMany()
  await prisma.book.deleteMany()
  await prisma.librarian.deleteMany()
  await prisma.user.deleteMany()
  for (const tgId of [ADMIN, OTHER_ADMIN, PERSON, FRIEND]) {
    await prisma.user.create({ data: { tgId, username: `u${tgId}`, firstName: `Имя${tgId}` } })
  }
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

const restrict = (scope: any, days: number | null = null, target = PERSON) =>
  restrictUser({ actorTg: ADMIN, targetTg: target, scope, reason: 'спам в отзывах', days })

test('ограничение точечное: закрыты отзывы, остальное доступно', async () => {
  assert.deepEqual(await restrict('reviews').then((r) => r.ok), true)

  const reviews = await checkUserCan(PERSON, 'reviews')
  assert.equal(reviews.allowed, false)
  assert.equal((reviews as any).code, 'restricted')
  // всё остальное человек делает как раньше
  for (const scope of ['add_books', 'waitlist', 'ai', 'market', 'reports'] as const) {
    assert.equal((await checkUserCan(PERSON, scope)).allowed, true, scope)
  }
})

test('ограничение add_books не прячет уже существующую полку', async () => {
  const librarian = await prisma.librarian.create({ data: { name: 'Хозяин', tgId: PERSON } })
  const book = await prisma.book.create({ data: { title: 'Книга', ownerId: librarian.id } })
  await restrict('add_books')

  const r = await app.inject({ method: 'GET', url: '/api/my-shelf', headers: asUser(PERSON) })
  assert.equal(r.statusCode, 200)
  assert.equal(r.json().books.length, 1)
  assert.equal(r.json().books[0].id, book.id)
})

test('scope all закрывает всё, но это не блокировка аккаунта', async () => {
  await restrict('all')
  for (const scope of ['add_books', 'reviews', 'waitlist', 'ai'] as const) {
    const v = await checkUserCan(PERSON, scope)
    assert.equal(v.allowed, false, scope)
    assert.equal((v as any).code, 'restricted', 'это ограничение, а не бан')
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { tgId: PERSON } })
  assert.equal(user.accountStatus, 'active')
})

test('срок ограничения истекает сам, без вмешательства', async () => {
  await restrict('reviews', 7)
  const later = new Date(Date.now() + 8 * 86_400_000)
  assert.equal((await checkUserCan(PERSON, 'reviews')).allowed, false)
  assert.equal((await checkUserCan(PERSON, 'reviews', later)).allowed, true)
  assert.equal((await activeRestrictions(PERSON, later)).length, 0)
})

test('повторное ограничение того же действия не плодит дубли', async () => {
  assert.equal((await restrict('reviews')).ok, true)
  const again = await restrict('reviews')
  assert.deepEqual(again, { ok: false, code: 'already_restricted' })
  assert.equal(await prisma.userRestriction.count({ where: { userTg: PERSON } }), 1)
  // и второго решения в журнале тоже нет
  assert.equal(await prisma.moderationAction.count({ where: { action: 'restrict' } }), 1)
})

test('причина обязательна для ограничения, блокировки и удаления отзыва', async () => {
  assert.deepEqual(
    await restrictUser({ actorTg: ADMIN, targetTg: PERSON, scope: 'reviews', reason: '  ' }),
    { ok: false, code: 'no_reason' },
  )
  assert.deepEqual(await banUser({ actorTg: ADMIN, targetTg: PERSON, reason: '' }), {
    ok: false,
    code: 'no_reason',
  })
  const review = await prisma.review.create({
    data: { workKey: 'ключ', authorTg: PERSON, rating: 1 },
  })
  assert.deepEqual(
    await decideReview({ actorTg: ADMIN, reviewId: review.id, decision: 'delete', reason: '' }),
    { ok: false, code: 'no_reason' },
  )
})

test('себя и админа заблокировать нельзя', async () => {
  assert.deepEqual(await banUser({ actorTg: ADMIN, targetTg: ADMIN, reason: 'ой' }), {
    ok: false,
    code: 'self',
  })
  assert.deepEqual(await banUser({ actorTg: ADMIN, targetTg: OTHER_ADMIN, reason: 'ой' }), {
    ok: false,
    code: 'admin',
  })
  assert.equal(
    (await prisma.user.findUniqueOrThrow({ where: { tgId: OTHER_ADMIN } })).accountStatus,
    'active',
  )
})

test('блокировка закрывает новые действия, повторная — идемпотентна', async () => {
  const r = await banUser({ actorTg: ADMIN, targetTg: PERSON, reason: 'оскорбления' })
  assert.equal(r.ok, true)
  const v = await checkUserCan(PERSON, 'add_books')
  assert.equal(v.allowed, false)
  assert.equal((v as any).code, 'banned')
  assert.match(explainVerdict(v as any), /Ваши данные/)

  const again = await banUser({ actorTg: ADMIN, targetTg: PERSON, reason: 'ещё раз' })
  assert.deepEqual(again, { ok: false, code: 'already_banned' })
  assert.equal(await prisma.moderationAction.count({ where: { action: 'ban' } }), 1)
})

test('заблокированный не добавит книгу через API, но заберёт и удалит свои данные', async () => {
  await banUser({ actorTg: ADMIN, targetTg: PERSON, reason: 'спам' })

  const add = await app.inject({
    method: 'POST',
    url: '/api/books',
    headers: asUser(PERSON),
    payload: { title: 'Новая книга', city: 'Warszawa' },
  })
  assert.equal(add.statusCode, 403)
  assert.equal(add.json().error, 'banned')
  assert.match(add.json().message, /доступ к проекту закрыт/i)
  assert.equal(await prisma.book.count(), 0)

  // а вот это блокировка перекрывать не имеет права
  const dump = await app.inject({ method: 'GET', url: '/api/me/export', headers: asUser(PERSON) })
  assert.equal(dump.statusCode, 200)
  const del = await app.inject({
    method: 'POST',
    url: '/api/me/delete-request',
    headers: asUser(PERSON),
    payload: { confirm: 'УДАЛИТЬ' },
  })
  assert.equal(del.statusCode, 200)
  assert.equal(await prisma.user.count({ where: { tgId: PERSON } }), 0)
})

test('ограничение reviews не мешает вернуть чужую книгу', async () => {
  const librarian = await prisma.librarian.create({ data: { name: 'Владелец', tgId: FRIEND } })
  const book = await prisma.book.create({
    data: { title: 'Чужая книга', ownerId: librarian.id, status: 'busy' },
  })
  const loan = await prisma.loan.create({
    data: {
      title: book.title,
      bookId: book.id,
      ownerTg: FRIEND,
      holderTg: PERSON,
      status: 'active',
      activeBookId: book.id,
    },
  })
  await restrict('reviews')

  const r = await app.inject({
    method: 'POST',
    url: `/api/loans/${loan.id}/return`,
    headers: asUser(PERSON),
  })
  assert.equal(r.statusCode, 200, 'возврат закрывает обязательство и не наказывается')
  assert.equal(
    (await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).status,
    'returned',
  )
})

test('снятие чужого решения тоже попадает в журнал', async () => {
  await restrict('reviews')
  const r = await unrestrictUser({
    actorTg: OTHER_ADMIN,
    targetTg: PERSON,
    scope: 'reviews',
    reason: 'разобрались, жалобы были массовыми',
  })
  assert.equal(r.ok, true)
  assert.equal((await checkUserCan(PERSON, 'reviews')).allowed, true)

  const log = await prisma.moderationAction.findMany({ orderBy: { createdAt: 'asc' } })
  assert.deepEqual(
    log.map((a) => [a.action, String(a.actorTg)]),
    [
      ['restrict', String(ADMIN)],
      ['unrestrict', String(OTHER_ADMIN)],
    ],
  )
  // само ограничение не удалено: история решений должна остаться
  assert.equal(await prisma.userRestriction.count({ where: { userTg: PERSON } }), 1)
})

test('повторное снятие честно отвечает, что снимать нечего', async () => {
  assert.deepEqual(
    await unrestrictUser({ actorTg: ADMIN, targetTg: PERSON, scope: 'reviews', reason: 'ок' }),
    { ok: false, code: 'not_restricted' },
  )
})

test('решение по отзыву: скрыть, вернуть, и повтор не делает второго', async () => {
  const review = await prisma.review.create({
    data: { workKey: 'ключ', authorTg: PERSON, rating: 1, text: 'грубость' },
  })
  await prisma.reviewReport.create({ data: { reviewId: review.id, reporterTg: FRIEND } })

  const hide = await decideReview({
    actorTg: ADMIN,
    reviewId: review.id,
    decision: 'hide',
    reason: 'оскорбление',
  })
  assert.equal(hide.ok, true)
  assert.deepEqual(
    await decideReview({ actorTg: ADMIN, reviewId: review.id, decision: 'hide', reason: 'ещё' }),
    { ok: false, code: 'already_hidden' },
  )

  const back = await decideReview({
    actorTg: OTHER_ADMIN,
    reviewId: review.id,
    decision: 'restore',
    reason: 'пересмотрели',
  })
  assert.equal(back.ok, true)
  const after = await prisma.review.findUniqueOrThrow({ where: { id: review.id } })
  assert.equal(after.status, 'visible')
  assert.equal(after.reports, 0, 'жалобы обнулены вместе с возвратом')
  assert.equal(await prisma.reviewReport.count({ where: { reviewId: review.id } }), 0)
  assert.equal(await prisma.moderationAction.count({ where: { targetType: 'review' } }), 2)
})

test('три жалобы прячут отзыв, но НЕ блокируют человека автоматически', async () => {
  const review = await prisma.review.create({
    data: { workKey: 'ключ', authorTg: PERSON, rating: 1, text: 'мнение' },
  })
  const { reportReview } = await import('./reviews.js')
  await reportReview(review.id, FRIEND)
  await reportReview(review.id, ADMIN)
  await reportReview(review.id, OTHER_ADMIN)

  assert.equal((await prisma.review.findUniqueOrThrow({ where: { id: review.id } })).status, 'hidden')
  // автобана нет: организованные жалобы не должны сами по себе закрывать доступ
  const user = await prisma.user.findUniqueOrThrow({ where: { tgId: PERSON } })
  assert.equal(user.accountStatus, 'active')
  assert.equal((await activeRestrictions(PERSON)).length, 0)
})

test('очередь разбора показывает жалобы, ограничения и последние решения', async () => {
  const review = await prisma.review.create({
    data: { workKey: 'ключ', authorTg: PERSON, rating: 2, text: 'текст' },
  })
  await prisma.reviewReport.create({ data: { reviewId: review.id, reporterTg: FRIEND } })
  await restrict('reviews')
  await banUser({ actorTg: ADMIN, targetTg: FRIEND, reason: 'спам' })

  const q = await moderationQueue()
  assert.equal(q.reviews.length, 1)
  assert.equal(q.reviews[0].reports, 1)
  assert.equal(q.reviews[0].authorTg, String(PERSON))
  assert.equal(q.restrictions.length, 1)
  assert.equal(q.banned.length, 1)
  assert.ok(q.recent.length >= 2)
  // имён пожаловавшихся в очереди нет: модератору хватает их числа и дат
  assert.ok(!JSON.stringify(q.reviews).includes(String(FRIEND)))
})

test('очередь и решения доступны только админам', async () => {
  const anon = await app.inject({ method: 'GET', url: '/api/admin/moderation' })
  assert.equal(anon.statusCode, 401)
  const stranger = await app.inject({
    method: 'GET',
    url: '/api/admin/moderation',
    headers: asUser(PERSON),
  })
  assert.equal(stranger.statusCode, 403)
  const admin = await app.inject({
    method: 'GET',
    url: '/api/admin/moderation',
    headers: asUser(ADMIN),
  })
  assert.equal(admin.statusCode, 200)

  // и чужими руками ограничение не поставить
  const byStranger = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${FRIEND}/restrict`,
    headers: asUser(PERSON),
    payload: { scope: 'reviews', reason: 'мне не нравится' },
  })
  assert.equal(byStranger.statusCode, 403)
  assert.equal(await prisma.userRestriction.count(), 0)
})

test('одновременные нажатия двух админов дают одно ограничение', async () => {
  const [a, b] = await Promise.all([restrict('reviews'), restrict('reviews')])
  const okCount = [a, b].filter((r) => r.ok).length
  assert.equal(okCount, 1, 'ровно одно решение прошло')
  assert.equal(await prisma.userRestriction.count({ where: { userTg: PERSON } }), 1)
  assert.equal(await prisma.moderationAction.count({ where: { action: 'restrict' } }), 1)
})

test('/api/me отдаёт человеку его ограничения, чтобы приложение объяснило', async () => {
  await restrict('reviews', 5)
  const r = await app.inject({ method: 'POST', url: '/api/me', headers: asUser(PERSON) })
  assert.equal(r.statusCode, 200)
  const body = r.json()
  assert.equal(body.banned, false)
  assert.equal(body.restrictions.length, 1)
  assert.equal(body.restrictions[0].scope, 'reviews')
  assert.ok(body.restrictions[0].until)
})

test('разблокировка возвращает доступ и пишется в журнал', async () => {
  await banUser({ actorTg: ADMIN, targetTg: PERSON, reason: 'спам' })
  const r = await unbanUser({ actorTg: OTHER_ADMIN, targetTg: PERSON, reason: 'извинился' })
  assert.equal(r.ok, true)
  assert.equal((await checkUserCan(PERSON, 'add_books')).allowed, true)
  assert.equal(await prisma.moderationAction.count({ where: { action: 'unban' } }), 1)
  assert.deepEqual(await unbanUser({ actorTg: ADMIN, targetTg: PERSON, reason: 'ещё' }), {
    ok: false,
    code: 'not_banned',
  })
})
