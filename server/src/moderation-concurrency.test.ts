/**
 * Одновременные решения модераторов.
 *
 * Админов несколько, карточка разбора приходит каждому, и два человека вполне
 * могут нажать одну и ту же кнопку одновременно. Раньше «прочитал состояние →
 * записал» давало два решения в журнале и два письма человеку об одном и том же.
 *
 * Здесь же проверяется главный инвариант: решение и запись в журнал попадают в
 * базу ВМЕСТЕ. Если журнал не записался, состояние меняться не должно.
 *
 * Запуск: npm run test -w server
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `moderation-conc-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'
process.env.BOT_TOKEN = '123456:test-token'
process.env.NOTION_TOKEN_V2 = ''
const ADMIN_A = 991001n
const ADMIN_B = 991002n
process.env.ADMIN_IDS = `${ADMIN_A},${ADMIN_B}`

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { banUser, decideReview, restrictUser, unbanUser, unrestrictUser } = await import(
  './moderation.js'
)

const PERSON = 991010n

before(async () => {})

beforeEach(async () => {
  await prisma.notificationOutbox.deleteMany()
  await prisma.moderationAction.deleteMany()
  await prisma.userRestriction.deleteMany()
  await prisma.reviewReport.deleteMany()
  await prisma.review.deleteMany()
  await prisma.user.deleteMany()
  for (const tgId of [ADMIN_A, ADMIN_B, PERSON]) {
    await prisma.user.create({ data: { tgId, username: `u${tgId}` } })
  }
})

after(async () => {
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

/** Сколько писем ждёт отправки: их число и есть «сколько раз человека дёрнули». */
const noticeCount = () => prisma.notificationOutbox.count({ where: { recipientTg: PERSON } })

async function seedReview(status = 'visible') {
  return prisma.review.create({
    data: {
      workKey: 'ключ',
      authorTg: PERSON,
      rating: 1,
      text: 'текст',
      status,
      hiddenAt: status === 'hidden' ? new Date() : null,
    },
  })
}

test('одновременное снятие ограничения: одно решение и одно письмо', async () => {
  await restrictUser({ actorTg: ADMIN_A, targetTg: PERSON, scope: 'reviews', reason: 'спам' })
  await prisma.notificationOutbox.deleteMany()
  await prisma.moderationAction.deleteMany()

  const results = await Promise.all([
    unrestrictUser({ actorTg: ADMIN_A, targetTg: PERSON, scope: 'reviews', reason: 'разобрались' }),
    unrestrictUser({ actorTg: ADMIN_B, targetTg: PERSON, scope: 'reviews', reason: 'разобрались' }),
  ])
  assert.equal(results.filter((r) => r.ok).length, 1, 'прошло ровно одно снятие')
  assert.equal(await prisma.moderationAction.count({ where: { action: 'unrestrict' } }), 1)
  assert.equal(await noticeCount(), 1, 'человеку написали один раз')
})

test('одновременная разблокировка: одно решение и одно письмо', async () => {
  await banUser({ actorTg: ADMIN_A, targetTg: PERSON, reason: 'спам' })
  await prisma.notificationOutbox.deleteMany()
  await prisma.moderationAction.deleteMany()

  const results = await Promise.all([
    unbanUser({ actorTg: ADMIN_A, targetTg: PERSON, reason: 'извинился' }),
    unbanUser({ actorTg: ADMIN_B, targetTg: PERSON, reason: 'извинился' }),
  ])
  assert.equal(results.filter((r) => r.ok).length, 1)
  assert.equal(await prisma.moderationAction.count({ where: { action: 'unban' } }), 1)
  assert.equal(await noticeCount(), 1)
})

test('одновременная блокировка: один бан, одно письмо', async () => {
  const results = await Promise.all([
    banUser({ actorTg: ADMIN_A, targetTg: PERSON, reason: 'спам' }),
    banUser({ actorTg: ADMIN_B, targetTg: PERSON, reason: 'спам' }),
  ])
  assert.equal(results.filter((r) => r.ok).length, 1)
  assert.equal(await prisma.moderationAction.count({ where: { action: 'ban' } }), 1)
  assert.equal(await noticeCount(), 1)
})

test('одновременное «скрыть» одного отзыва: один hide', async () => {
  const review = await seedReview()
  const results = await Promise.all([
    decideReview({ actorTg: ADMIN_A, reviewId: review.id, decision: 'hide', reason: 'грубость' }),
    decideReview({ actorTg: ADMIN_B, reviewId: review.id, decision: 'hide', reason: 'грубость' }),
  ])
  assert.equal(results.filter((r) => r.ok).length, 1)
  assert.equal(await prisma.moderationAction.count({ where: { action: 'hide' } }), 1)
  assert.equal(await noticeCount(), 1)
  assert.equal((await prisma.review.findUniqueOrThrow({ where: { id: review.id } })).status, 'hidden')
})

test('«вернуть» и «удалить» одновременно: состояние остаётся осмысленным', async () => {
  const review = await seedReview('hidden')
  const [restore, remove] = await Promise.all([
    decideReview({ actorTg: ADMIN_A, reviewId: review.id, decision: 'restore', reason: 'ок' }),
    decideReview({ actorTg: ADMIN_B, reviewId: review.id, decision: 'delete', reason: 'нарушение' }),
  ])
  // оба решения допустимы, но итог должен быть непротиворечивым
  const left = await prisma.review.findUnique({ where: { id: review.id } })
  if (remove.ok) {
    assert.equal(left, null, 'удалили — значит отзыва нет')
  } else {
    assert.ok(restore.ok)
    assert.equal(left?.status, 'visible')
  }
  const actions = await prisma.moderationAction.count({ where: { targetId: review.id } })
  assert.equal(actions, [restore, remove].filter((r) => r.ok).length, 'решений в журнале ровно столько, сколько прошло')
})

test('«отклонить жалобы» и «скрыть» одновременно: без двойного решения', async () => {
  const review = await seedReview()
  await prisma.reviewReport.create({ data: { reviewId: review.id, reporterTg: ADMIN_B } })

  const results = await Promise.all([
    decideReview({ actorTg: ADMIN_A, reviewId: review.id, decision: 'dismiss', reason: 'мнение' }),
    decideReview({ actorTg: ADMIN_B, reviewId: review.id, decision: 'hide', reason: 'грубость' }),
  ])
  const passed = results.filter((r) => r.ok).length
  assert.ok(passed >= 1 && passed <= 2)
  const after = await prisma.review.findUniqueOrThrow({ where: { id: review.id } })
  assert.ok(['visible', 'hidden'].includes(after.status))
  assert.equal(await prisma.moderationAction.count({ where: { targetId: review.id } }), passed)
  assert.equal(await noticeCount(), passed, 'писем ровно столько, сколько решений')
})

/**
 * Журнал ломаем по-настоящему, на уровне базы: подменять клиент Prisma
 * бессмысленно — внутри транзакции работает ДРУГОЙ клиент (`tx`), и подмена
 * туда не доходит (первая версия теста молча проходила именно поэтому).
 */
async function withBrokenJournal<T>(fn: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe('ALTER TABLE ModerationAction RENAME TO ModerationAction_off')
  try {
    return await fn()
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE ModerationAction_off RENAME TO ModerationAction')
  }
}

test('сбой записи журнала откатывает и само решение', async () => {
  await withBrokenJournal(async () => {
    await assert.rejects(() =>
      restrictUser({ actorTg: ADMIN_A, targetTg: PERSON, scope: 'reviews', reason: 'спам' }),
    )
  })

  // главное: ограничения нет, раз о нём нет записи в журнале
  assert.equal(await prisma.userRestriction.count({ where: { userTg: PERSON } }), 0)
  assert.equal(await prisma.moderationAction.count(), 0)
  assert.equal(await noticeCount(), 0, 'и письмо не ушло')
})

test('сбой журнала при блокировке не оставляет человека заблокированным', async () => {
  await withBrokenJournal(async () => {
    await assert.rejects(() => banUser({ actorTg: ADMIN_A, targetTg: PERSON, reason: 'спам' }))
  })
  const user = await prisma.user.findUniqueOrThrow({ where: { tgId: PERSON } })
  assert.equal(user.accountStatus, 'active')
  assert.equal(await noticeCount(), 0)
})

test('сбой журнала при решении по отзыву не меняет отзыв', async () => {
  const review = await seedReview()
  await withBrokenJournal(async () => {
    await assert.rejects(() =>
      decideReview({ actorTg: ADMIN_A, reviewId: review.id, decision: 'hide', reason: 'грубость' }),
    )
  })
  assert.equal((await prisma.review.findUniqueOrThrow({ where: { id: review.id } })).status, 'visible')
  assert.equal(await noticeCount(), 0)
})
