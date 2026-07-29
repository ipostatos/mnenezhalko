/**
 * Сроки хранения: проверяем, что чистка действительно исполняет обещанное на
 * экране «Ваши данные», и — что важнее — НЕ трогает свежее и живое.
 *
 * Тут легко навредить: одна ошибка в условии, и правило вычистит активные
 * выдачи или профили людей, которые пользуются приложением каждый день.
 * Запуск: npm run test -w server
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `retention-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'
process.env.BOT_TOKEN = '123456:test-token'
process.env.NOTION_TOKEN_V2 = ''

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { RETENTION, applyRetention, describeRetention } = await import('./retention.js')
const { ERASED_NAME } = await import('./mydata.js')

const NOW = Date.parse('2026-07-30T12:00:00Z')
const DAY = 86_400_000
const daysAgo = (d: number) => new Date(NOW - d * DAY)

const ACTIVE = 980001n
const IDLE = 980002n

before(async () => {})

beforeEach(async () => {
  await prisma.notificationOutbox.deleteMany()
  await prisma.moderationAction.deleteMany()
  await prisma.userRestriction.deleteMany()
  await prisma.reviewReport.deleteMany()
  await prisma.review.deleteMany()
  await prisma.waiting.deleteMany()
  await prisma.loanEvent.deleteMany()
  await prisma.loan.deleteMany()
  await prisma.book.deleteMany()
  await prisma.librarian.deleteMany()
  await prisma.user.deleteMany()
  await prisma.user.create({
    data: { tgId: ACTIVE, username: 'active', firstName: 'Активный', seenAt: daysAgo(1) },
  })
  await prisma.user.create({
    data: { tgId: IDLE, username: 'idle', firstName: 'Забытый', seenAt: daysAgo(400) },
  })
})

after(async () => {
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

test('старая закрытая выдача обезличивается, но остаётся историей обмена', async () => {
  const old = await prisma.loan.create({
    data: {
      title: 'Давняя книга',
      ownerTg: ACTIVE,
      holderTg: IDLE,
      holderUsername: 'idle',
      holderName: 'Забытый',
      status: 'returned',
      returnedAt: daysAgo(RETENTION.closedLoanDays + 1),
    },
  })
  await prisma.loanEvent.create({ data: { loanId: old.id, kind: 'returned', byTg: ACTIVE } })

  const r = await applyRetention(NOW)
  assert.equal(r.выдач_обезличено, 1)

  const after = await prisma.loan.findUniqueOrThrow({ where: { id: old.id } })
  assert.equal(after.ownerTg, null)
  assert.equal(after.holderTg, null)
  assert.equal(after.holderUsername, null)
  assert.equal(after.holderName, ERASED_NAME)
  assert.equal(after.title, 'Давняя книга', 'сам обмен из истории не пропал')
  const event = await prisma.loanEvent.findFirstOrThrow({ where: { loanId: old.id } })
  assert.equal(event.byTg, null)
})

test('свежая и АКТИВНАЯ выдачи не трогаются', async () => {
  const fresh = await prisma.loan.create({
    data: {
      title: 'Вернули вчера',
      ownerTg: ACTIVE,
      holderUsername: 'idle',
      status: 'returned',
      returnedAt: daysAgo(3),
    },
  })
  const active = await prisma.loan.create({
    data: { title: 'На руках прямо сейчас', ownerTg: ACTIVE, holderUsername: 'idle', status: 'active' },
  })

  const r = await applyRetention(NOW)
  assert.equal(r.выдач_обезличено, 0)
  assert.equal((await prisma.loan.findUniqueOrThrow({ where: { id: fresh.id } })).ownerTg, ACTIVE)
  assert.equal((await prisma.loan.findUniqueOrThrow({ where: { id: active.id } })).ownerTg, ACTIVE)
})

test('закрытые записи очереди уходят, живая остаётся', async () => {
  const book = await prisma.book.create({ data: { title: 'Книга' } })
  await prisma.waiting.create({
    data: {
      bookId: book.id,
      userTg: ACTIVE,
      status: 'left',
      leftAt: daysAgo(RETENTION.closedWaitingDays + 1),
      expiresAt: daysAgo(1),
    },
  })
  const alive = await prisma.waiting.create({
    data: {
      bookId: book.id,
      userTg: IDLE,
      status: 'waiting',
      expiresAt: new Date(NOW + 30 * DAY),
    },
  })

  const r = await applyRetention(NOW)
  assert.equal(r.очередей_удалено, 1)
  assert.equal(await prisma.waiting.count({ where: { id: alive.id } }), 1)
})

test('скрытый отзыв удаляется по сроку, видимый — никогда', async () => {
  await prisma.review.create({
    data: {
      workKey: 'скрытый',
      authorTg: ACTIVE,
      rating: 1,
      text: 'спам',
      status: 'hidden',
      hiddenAt: daysAgo(RETENTION.hiddenReviewDays + 1),
    },
  })
  await prisma.review.create({
    data: { workKey: 'обычный', authorTg: ACTIVE, rating: 5, text: 'хорошая' },
  })
  await prisma.review.create({
    data: {
      workKey: 'скрытый-вчера',
      authorTg: IDLE,
      rating: 1,
      status: 'hidden',
      hiddenAt: daysAgo(2),
    },
  })

  const r = await applyRetention(NOW)
  assert.equal(r.отзывов_удалено, 1)
  const left = await prisma.review.findMany({ select: { workKey: true } })
  assert.deepEqual(left.map((x) => x.workKey).sort(), ['обычный', 'скрытый-вчера'])
})

test('давние жалобы на оставшийся видимым отзыв уходят', async () => {
  const review = await prisma.review.create({
    data: { workKey: 'ключ', authorTg: ACTIVE, rating: 3 },
  })
  await prisma.reviewReport.create({
    data: { reviewId: review.id, reporterTg: IDLE, createdAt: daysAgo(RETENTION.reportDays + 1) },
  })
  await prisma.reviewReport.create({ data: { reviewId: review.id, reporterTg: 980003n } })

  const r = await applyRetention(NOW)
  assert.equal(r.жалоб_удалено, 1)
  assert.equal(await prisma.reviewReport.count(), 1)
})

test('давно не заходивший ПУСТОЙ профиль удаляется', async () => {
  const r = await applyRetention(NOW)
  assert.equal(r.профилей_удалено, 1)
  assert.equal(await prisma.user.count({ where: { tgId: IDLE } }), 0)
  assert.equal(await prisma.user.count({ where: { tgId: ACTIVE } }), 1)
})

test('давно не заходивший профиль С книгами или выдачами остаётся', async () => {
  // у забытого профиля есть библиотекарь с книгой — это не «пустой» профиль
  await prisma.librarian.create({ data: { name: 'Забытый', tgId: IDLE } })
  const r = await applyRetention(NOW)
  assert.equal(r.профилей_удалено, 0)
  assert.equal(await prisma.user.count({ where: { tgId: IDLE } }), 1)
})

test('профиль с историей выдач не удаляется даже без книг', async () => {
  await prisma.loan.create({
    data: {
      title: 'Брал почитать',
      ownerTg: ACTIVE,
      holderTg: IDLE,
      status: 'returned',
      returnedAt: daysAgo(10),
    },
  })
  const r = await applyRetention(NOW)
  assert.equal(r.профилей_удалено, 0)
  assert.equal(await prisma.user.count({ where: { tgId: IDLE } }), 1)
})

test('старые решения модераторов уходят, свежие остаются', async () => {
  await prisma.moderationAction.create({
    data: {
      actorTg: ACTIVE,
      targetUserTg: IDLE,
      targetType: 'user',
      action: 'restrict',
      reason: 'давнее решение',
      createdAt: daysAgo(RETENTION.moderationLogDays + 1),
    },
  })
  await prisma.moderationAction.create({
    data: {
      actorTg: ACTIVE,
      targetUserTg: IDLE,
      targetType: 'user',
      action: 'ban',
      reason: 'свежее решение',
      createdAt: daysAgo(10),
    },
  })

  const r = await applyRetention(NOW)
  assert.equal(r.решений_модерации_удалено, 1)
  const left = await prisma.moderationAction.findMany()
  assert.deepEqual(left.map((a) => a.reason), ['свежее решение'])
})

test('отправленные письма чистятся, неотправленные ждут', async () => {
  await prisma.notificationOutbox.create({
    data: {
      recipientTg: IDLE,
      kind: 'moderation',
      payload: 'давно доставлено',
      createdAt: daysAgo(60),
      sentAt: daysAgo(60),
    },
  })
  await prisma.notificationOutbox.create({
    data: { recipientTg: IDLE, kind: 'moderation', payload: 'ещё не ушло', createdAt: daysAgo(60) },
  })

  const r = await applyRetention(NOW)
  assert.equal(r.писем_удалено, 1)
  const left = await prisma.notificationOutbox.findMany()
  assert.deepEqual(left.map((n) => n.payload), ['ещё не ушло'])
})

test('на чистой базе чистка ничего не делает и говорит об этом', async () => {
  await prisma.user.deleteMany({ where: { tgId: IDLE } })
  const r = await applyRetention(NOW)
  assert.equal(describeRetention(r), 'чистить нечего')
})
