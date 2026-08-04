/**
 * «Мои данные»: выгрузка и удаление.
 *
 * Удаление — самая опасная операция в проекте: она необратима и затрагивает
 * чужие записи (у выдачи две стороны). Проверяем ровно это: что уходит
 * насовсем, что остаётся обезличенным, что НЕ трогается у других людей и когда
 * удаление обязано отказать.
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

const DB_FILE = join(tmpdir(), `mydata-test-${randomUUID()}.db`)
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
  ERASED_NAME,
  deleteMyData,
  exportMyData,
  openLoansOf,
  reapplyDeletions,
  setBookGoneNotifier,
  tgHash,
} = await import('./mydata.js')

const ME = 970001n
const FRIEND = 970002n
const STRANGER = 970003n

const app = Fastify()

function asUser(tgId: bigint, username = 'me') {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: Number(tgId), username, first_name: 'Имя' }),
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
  await prisma.reviewReport.deleteMany()
  await prisma.review.deleteMany()
  await prisma.workRating.deleteMany()
  await prisma.waiting.deleteMany()
  await prisma.loanEvent.deleteMany()
  await prisma.loan.deleteMany()
  await prisma.book.deleteMany()
  await prisma.librarian.deleteMany()
  await prisma.marketItem.deleteMany()
  await prisma.deletionRequest.deleteMany()
  await prisma.waiting.deleteMany()
  await prisma.notificationOutbox.deleteMany()
  await prisma.moderationAction.deleteMany()
  await prisma.userRestriction.deleteMany()
  await prisma.user.deleteMany()
  for (const [tgId, username] of [
    [ME, 'me'],
    [FRIEND, 'friend'],
    [STRANGER, 'stranger'],
  ] as const) {
    await prisma.user.create({
      data: { tgId, username, firstName: `Имя-${username}`, city: 'Warszawa' },
    })
  }
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

/** Полка человека с одной книгой. */
async function seedShelf(tgId: bigint, title = 'Моя книга') {
  const librarian = await prisma.librarian.create({
    data: { name: 'Хозяин полки', tgId, telegram: 'me', telegramNorm: 'me', city: 'Warszawa' },
  })
  const book = await prisma.book.create({
    data: {
      title,
      author: 'Автор',
      ownerId: librarian.id,
      addedByTg: tgId,
      coverUrl: 'https://example.org/cover.jpg',
      source: 'bot',
    },
  })
  return { librarian, book }
}

test('выгрузка содержит профиль, полку, выдачи и отзывы', async () => {
  const { book } = await seedShelf(ME)
  await prisma.loan.create({
    data: {
      title: book.title,
      bookId: book.id,
      ownerTg: ME,
      holderTg: FRIEND,
      holderUsername: 'friend',
      status: 'returned',
      returnedAt: new Date(),
    },
  })
  await prisma.review.create({
    data: { workKey: 'моя книга|автор', authorTg: ME, rating: 5, text: 'хорошая' },
  })

  const dump = await exportMyData(ME)
  assert.equal(dump.профиль?.telegram_id, String(ME))
  assert.equal(dump.книги.length, 1)
  assert.equal(dump.выдачи.length, 1)
  assert.equal(dump.отзывы.length, 1)
})

test('выгрузка отдаётся файлом и только по подписи', async () => {
  const anon = await app.inject({ method: 'GET', url: '/api/me/export' })
  assert.equal(anon.statusCode, 401)

  const r = await app.inject({ method: 'GET', url: '/api/me/export', headers: asUser(ME) })
  assert.equal(r.statusCode, 200)
  assert.match(r.headers['content-disposition'] as string, /attachment; filename=/)
  assert.equal(r.json().профиль.telegram_id, String(ME))
})

test('незакрытая выдача блокирует удаление: у кого-то на руках чужая книга', async () => {
  const { book } = await seedShelf(ME)
  await prisma.loan.create({
    data: {
      title: book.title,
      bookId: book.id,
      ownerTg: ME,
      holderUsername: 'friend',
      status: 'active',
      activeBookId: book.id,
    },
  })

  const r = await deleteMyData(ME)
  assert.ok('error' in r && r.error === 'active_loans')
  assert.equal((r as any).loans[0].role, 'дали почитать')
  // и ничего не тронуто
  assert.equal(await prisma.user.count({ where: { tgId: ME } }), 1)
})

test('удаление: своё уходит насовсем, история обмена остаётся обезличенной', async () => {
  const { librarian, book } = await seedShelf(ME)
  const closed = await prisma.loan.create({
    data: {
      title: book.title,
      bookId: book.id,
      ownerTg: ME,
      holderTg: FRIEND,
      holderUsername: 'friend',
      holderName: 'Имя-friend',
      status: 'returned',
      returnedAt: new Date(),
    },
  })
  await prisma.loanEvent.create({ data: { loanId: closed.id, kind: 'created', byTg: ME } })
  await prisma.review.create({
    data: { workKey: 'ключ', authorTg: ME, rating: 4, text: 'мой отзыв' },
  })
  await prisma.workRating.create({ data: { workKey: 'ключ', count: 1, sum: 4 } })
  await prisma.waiting.create({
    data: {
      bookId: book.id,
      userTg: ME,
      status: 'waiting',
      expiresAt: new Date(Date.now() + 86400_000),
    },
  })

  const r = await deleteMyData(ME)
  assert.ok(!('error' in r))
  assert.equal(r.summary.книг_скрыто, 1)
  assert.equal(r.summary.отзывов_удалено, 1)

  // профиль, отзывы и очереди исчезли физически
  assert.equal(await prisma.user.count({ where: { tgId: ME } }), 0)
  assert.equal(await prisma.review.count(), 0)
  assert.equal(await prisma.waiting.count(), 0)
  assert.equal(await prisma.workRating.count(), 0, 'средняя не помнит удалённый отзыв')

  // выдача осталась историей, но человека в ней не опознать
  const loan = await prisma.loan.findUniqueOrThrow({ where: { id: closed.id } })
  assert.equal(loan.ownerTg, null)
  assert.equal(loan.title, book.title, 'сама запись обмена никуда не делась')
  const event = await prisma.loanEvent.findFirstOrThrow({ where: { loanId: closed.id } })
  assert.equal(event.byTg, null)

  // библиотекарь обезличен, книги ушли с полки
  const after = await prisma.librarian.findUniqueOrThrow({ where: { id: librarian.id } })
  assert.equal(after.name, ERASED_NAME)
  assert.equal(after.telegram, null)
  assert.equal(after.tgId, null)
  const b = await prisma.book.findUniqueOrThrow({ where: { id: book.id } })
  assert.equal(b.active, false)
  assert.equal(b.coverUrl, null)
  assert.equal(b.addedByTg, null)
})

test('удаление не трогает данные других людей', async () => {
  const { book } = await seedShelf(ME)
  const other = await prisma.librarian.create({
    data: { name: 'Чужая полка', tgId: FRIEND, telegram: 'friend', city: 'Kraków' },
  })
  const otherBook = await prisma.book.create({
    data: { title: 'Чужая книга', ownerId: other.id, addedByTg: FRIEND },
  })
  await prisma.review.create({
    data: { workKey: 'общий ключ', authorTg: FRIEND, rating: 5, text: 'чужой отзыв' },
  })
  await prisma.workRating.create({ data: { workKey: 'общий ключ', count: 1, sum: 5 } })
  // мой отзыв на то же произведение
  await prisma.review.create({ data: { workKey: 'общий ключ', authorTg: ME, rating: 1, text: 'мой' } })

  await deleteMyData(ME)

  assert.equal(await prisma.user.count({ where: { tgId: FRIEND } }), 1)
  const kept = await prisma.book.findUniqueOrThrow({ where: { id: otherBook.id } })
  assert.equal(kept.active, true)
  assert.equal(kept.addedByTg, FRIEND)
  const otherOwner = await prisma.librarian.findUniqueOrThrow({ where: { id: other.id } })
  assert.equal(otherOwner.name, 'Чужая полка')
  const reviews = await prisma.review.findMany()
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].authorTg, FRIEND)
  // средняя пересчитана без моего отзыва, а не удалена вместе с чужим
  const rating = await prisma.workRating.findUniqueOrThrow({ where: { workKey: 'общий ключ' } })
  assert.deepEqual({ count: rating.count, sum: rating.sum }, { count: 1, sum: 5 })
  assert.equal((await prisma.book.findUniqueOrThrow({ where: { id: book.id } })).active, false)
})

test('жалобы удалившегося исчезают, но чужой отзыв не воскресает', async () => {
  const review = await prisma.review.create({
    data: { workKey: 'ключ', authorTg: STRANGER, rating: 1, text: 'спорный', reports: 1 },
  })
  await prisma.reviewReport.create({ data: { reviewId: review.id, reporterTg: ME } })

  await deleteMyData(ME)

  assert.equal(await prisma.reviewReport.count(), 0)
  assert.equal(await prisma.review.count({ where: { id: review.id } }), 1)
})

test('очереди чужих людей на ваши книги закрываются, и им сообщают', async () => {
  const { book } = await seedShelf(ME)
  await prisma.waiting.create({
    data: {
      bookId: book.id,
      userTg: FRIEND,
      status: 'waiting',
      expiresAt: new Date(Date.now() + 86400_000),
    },
  })
  const notices: { userTg: bigint; title: string }[] = []
  setBookGoneNotifier((list) => {
    notices.push(...list)
  })

  const r = await deleteMyData(ME)
  assert.ok(!('error' in r))
  assert.equal(r.summary.чужих_ожиданий_закрыто, 1)
  // человеку сказали, и сказали про КОНКРЕТНУЮ книгу
  assert.deepEqual(notices, [{ userTg: FRIEND, title: book.title }])
  // а сама запись очереди закрыта, чтобы книга никого больше не ждала
  const waiting = await prisma.waiting.findFirstOrThrow({ where: { userTg: FRIEND } })
  assert.equal(waiting.status, 'left')
  setBookGoneNotifier(() => {})
})

test('предпросмотр объясняет последствия словами, а не только числами', async () => {
  await seedShelf(ME)
  const r = await deleteMyData(ME, { dryRun: true })
  assert.ok(!('error' in r))
  assert.ok(
    r.effects.some((e) => e.includes('снимется с полки') || e.includes('снимутся')),
    'про книги в каталоге сказано прямо',
  )
  assert.ok(r.effects.some((e) => e.includes('Профиль')))
})

test('удалённая книга не остаётся «свободной» в каталоге', async () => {
  const { book } = await seedShelf(ME)
  await prisma.book.update({ where: { id: book.id }, data: { status: 'busy' } })
  await deleteMyData(ME)
  const after = await prisma.book.findUniqueOrThrow({ where: { id: book.id } })
  assert.equal(after.active, false)
  assert.equal(after.reviewStatus, 'deleted')
  assert.equal(after.status, 'free', 'зависший busy не должен пережить владельца')
})

test('отпечаток в журнале — HMAC с отдельным секретом, а не хэш от id', async () => {
  const crypto = await import('node:crypto')
  const naive = crypto.createHash('sha256').update(String(ME)).digest('hex')
  assert.notEqual(tgHash(ME), naive, 'простой sha256 от Telegram id перебирается')
  // тот же id — тот же отпечаток, иначе повторное применение не сработает
  assert.equal(tgHash(ME), tgHash(ME))
  assert.notEqual(tgHash(ME), tgHash(FRIEND))
})

test('выгрузка показывает ограничения и решения по человеку', async () => {
  const { restrictUser } = await import('./moderation.js')
  await prisma.user.create({ data: { tgId: 970099n, username: 'admin' } })
  await restrictUser({
    actorTg: 970099n,
    targetTg: ME,
    scope: 'reviews',
    reason: 'спам в отзывах',
    days: 7,
  })

  const dump: any = await exportMyData(ME)
  assert.equal(dump.ограничения_и_модерация.состояние_аккаунта, 'active')
  assert.equal(dump.ограничения_и_модерация.ограничения.length, 1)
  assert.equal(dump.ограничения_и_модерация.ограничения[0].что_закрыто, 'reviews')
  assert.equal(dump.ограничения_и_модерация.решения_по_мне.length, 1)
  assert.equal(dump.ограничения_и_модерация.решения_по_мне[0].что, 'restrict')
  // кто именно из админов решил — это данные о модераторе, не о человеке
  assert.ok(!JSON.stringify(dump.ограничения_и_модерация.решения_по_мне).includes('970099'))
})

test('удаление обезличивает журнал модерации, но не стирает историю решений', async () => {
  const { restrictUser } = await import('./moderation.js')
  await prisma.user.update({ where: { tgId: ME }, data: { username: 'vasya', firstName: 'Вася' } })
  await prisma.user.create({ data: { tgId: 970099n, username: 'admin' } })
  await restrictUser({
    actorTg: 970099n,
    targetTg: ME,
    scope: 'reviews',
    reason: 'спам от @vasya, жалобы на Вася',
  })

  await deleteMyData(ME)

  const log = await prisma.moderationAction.findMany()
  assert.equal(log.length, 1, 'сам факт решения остаётся: без него ничего не объяснить')
  assert.equal(log[0].targetUserTg, null, 'сырого Telegram id в журнале больше нет')
  assert.equal(log[0].targetHash, tgHash(ME))
  assert.ok(!log[0].reason.includes('vasya'), 'ник вычищен из причины')
  assert.ok(!log[0].reason.includes('Вася'), 'имя вычищено из причины')
  assert.match(log[0].reason, /спам от/, 'смысл решения сохранён')
  // ограничения ушли вместе с профилем (каскадом)
  assert.equal(await prisma.userRestriction.count({ where: { userTg: ME } }), 0)
  // и неотправленные письма человеку тоже
  assert.equal(await prisma.notificationOutbox.count({ where: { recipientTg: ME } }), 0)
})

test('решения удалившегося АДМИНА тоже обезличиваются', async () => {
  const { restrictUser } = await import('./moderation.js')
  await restrictUser({ actorTg: ME, targetTg: FRIEND, scope: 'reviews', reason: 'спам' })

  await deleteMyData(ME)

  const log = await prisma.moderationAction.findFirstOrThrow()
  assert.equal(log.actorTg, null)
  assert.equal(log.actorHash, tgHash(ME))
  assert.equal(log.targetUserTg, FRIEND, 'вторая сторона решения не пострадала')
})

test('ручка удаления требует осознанного подтверждения', async () => {
  await seedShelf(ME)
  const noConfirm = await app.inject({
    method: 'POST',
    url: '/api/me/delete-request',
    headers: asUser(ME),
    payload: {},
  })
  assert.equal(noConfirm.statusCode, 400)
  assert.equal(noConfirm.json().error, 'confirm_required')
  assert.equal(await prisma.user.count({ where: { tgId: ME } }), 1)

  const ok = await app.inject({
    method: 'POST',
    url: '/api/me/delete-request',
    headers: asUser(ME),
    payload: { confirm: 'УДАЛИТЬ' },
  })
  assert.equal(ok.statusCode, 200)
  assert.equal(await prisma.user.count({ where: { tgId: ME } }), 0)
})

test('предпросмотр показывает, что исчезнет, и ничего не меняет', async () => {
  await seedShelf(ME)
  const r = await app.inject({
    method: 'GET',
    url: '/api/me/delete-preview',
    headers: asUser(ME),
  })
  assert.equal(r.statusCode, 200)
  assert.equal(r.json().summary.книг_скрыто, 1)
  assert.equal(await prisma.user.count({ where: { tgId: ME } }), 1)
  assert.equal(await prisma.book.count({ where: { active: true } }), 1)
})

test('в журнале удалений нет самого Telegram id, только хэш', async () => {
  await seedShelf(ME)
  await deleteMyData(ME)

  const rows = await prisma.deletionRequest.findMany()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].tgHash, tgHash(ME))
  assert.ok(!JSON.stringify(rows).includes(String(ME)), 'id в журнале быть не должно')
})

test('после восстановления старой копии удаление применяется повторно', async () => {
  await seedShelf(ME)
  await deleteMyData(ME)
  // имитируем восстановление резервной копии: человек снова в базе
  await prisma.user.create({ data: { tgId: ME, username: 'me', firstName: 'Вернулся' } })
  assert.equal(await prisma.user.count({ where: { tgId: ME } }), 1)

  const r = await reapplyDeletions(() => {})
  assert.deepEqual(r, { found: 1, erased: 1 })
  assert.equal(await prisma.user.count({ where: { tgId: ME } }), 0)
})

test('повторное применение не трогает тех, кто удаления не просил', async () => {
  await seedShelf(ME)
  await deleteMyData(ME)
  const r = await reapplyDeletions(() => {})
  assert.equal(r.erased, 0)
  assert.equal(await prisma.user.count({ where: { tgId: FRIEND } }), 1)
})

test('незакрытые выдачи видно с обеих сторон', async () => {
  const { book } = await seedShelf(ME)
  await prisma.loan.create({
    data: {
      title: book.title,
      bookId: book.id,
      ownerTg: FRIEND,
      holderTg: ME,
      status: 'active',
      activeBookId: book.id,
    },
  })
  const mine = await openLoansOf(ME)
  assert.equal(mine.length, 1)
  const blocked = await deleteMyData(ME)
  assert.ok('error' in blocked)
  assert.equal((blocked as any).loans[0].role, 'взяли почитать')
})

/* ── выгрузка приходит файлом в чат с ботом ──────────────────
   Скачивание blob-ссылкой внутри вебвью Telegram подвешивало приложение
   (жалоба user 4.08.2026), поэтому файл отправляет бот. Проверяем, что ручка
   действительно шлёт документ тому, кто её позвал, и что отказ Telegram
   виден клиенту, а не проглатывается. */

const { bot } = await import('./bot.js')

let sentCalls: { method: string; payload: any }[] = []
let sendFails = false

bot.api.config.use(async (prev, method, payload: any, signal) => {
  sentCalls.push({ method, payload })
  if (method === 'sendDocument') {
    if (sendFails) throw new Error('Forbidden: bot was blocked by the user')
    return { ok: true, result: {} } as any
  }
  return prev(method, payload, signal)
})

test('выгрузка отправляется документом в чат с тем, кто её попросил', async () => {
  sentCalls = []
  sendFails = false
  await seedShelf(ME)

  const r = await app.inject({ method: 'POST', url: '/api/me/export/send', headers: asUser(ME) })
  assert.equal(r.statusCode, 200)

  const call = sentCalls.find((c) => c.method === 'sendDocument')
  assert.ok(call, 'бот должен был отправить документ')
  assert.equal(call!.payload.chat_id, Number(ME))
  assert.match(call!.payload.document.filename, /^mnenezhalko-\d{4}-\d{2}-\d{2}\.json$/)
})

test('если бот не смог прислать файл, клиент узнаёт об этом (502)', async () => {
  sentCalls = []
  sendFails = true
  await seedShelf(ME)

  const r = await app.inject({ method: 'POST', url: '/api/me/export/send', headers: asUser(ME) })
  assert.equal(r.statusCode, 502)
  assert.equal(r.json().error, 'send_failed')
  sendFails = false
})

test('чужие данные так не заберёшь: без подписи Telegram — 401', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/me/export/send' })
  assert.equal(r.statusCode, 401)
})
