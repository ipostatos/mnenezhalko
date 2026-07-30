/**
 * Снятие карточки барахолки (`/market_remove`, `POST /api/admin/market/:id/remove`).
 *
 * До 30 июля 2026 убрать объявление было нечем вовсе: статус меняли только джоба
 * протухания и удаление профиля автора. Проверяется то, что делает такую
 * операцию безопасной: причина обязательна, решение одно на два одновременных
 * нажатия, строка не удаляется физически, а сбой журнала откатывает снятие —
 * объявление не может исчезнуть без объяснения и без следа.
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

const DB_FILE = join(tmpdir(), `market-remove-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'
process.env.BOT_TOKEN = '123456:test-token-for-signature'
process.env.NOTION_TOKEN_V2 = ''
const ADMIN = 992001n
const OTHER_ADMIN = 992002n
process.env.ADMIN_IDS = `${ADMIN},${OTHER_ADMIN}`

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { registerRoutes } = await import('./routes.js')
const { removeMarketItem } = await import('./market.js')

const AUTHOR = 992010n
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
  await prisma.notificationOutbox.deleteMany()
  await prisma.moderationAction.deleteMany()
  await prisma.marketItem.deleteMany()
  await prisma.user.deleteMany()
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

async function seedItem(over: Record<string, unknown> = {}) {
  await prisma.user.upsert({
    where: { tgId: AUTHOR },
    create: { tgId: AUTHOR, username: 'seller', firstName: 'Продавец' },
    update: {},
  })
  return prisma.marketItem.create({
    data: {
      city: 'Kraków',
      kind: 'sell',
      title: 'Две книги',
      description: 'Продаю две книги',
      price: '80 zł',
      status: 'active',
      source: 'topic',
      sourceMsgId: 21960,
      authorTg: AUTHOR,
      authorUsername: 'seller',
      expiresAt: new Date(Date.now() + 45 * 86_400_000),
      ...over,
    },
  })
}

/* ── ядро ─────────────────────────────────────────────────── */

test('админ снимает карточку: статус, журнал и письмо автору', async () => {
  const item = await seedItem()
  const res = await removeMarketItem({ actorTg: ADMIN, id: item.id, reason: 'реклама' })
  assert.equal(res.ok, true)

  const fresh = await prisma.marketItem.findUniqueOrThrow({ where: { id: item.id } })
  assert.equal(fresh.status, 'removed')
  assert.ok(fresh.title, 'строка на месте: снятие обратимо, физически не удаляем')

  const log = await prisma.moderationAction.findMany()
  assert.equal(log.length, 1)
  assert.equal(log[0].action, 'remove')
  assert.equal(log[0].targetType, 'market')
  assert.equal(log[0].targetId, item.id)
  assert.equal(log[0].actorTg, ADMIN)
  assert.equal(log[0].reason, 'реклама')

  const mail = await prisma.notificationOutbox.findMany()
  assert.equal(mail.length, 1)
  assert.equal(mail[0].recipientTg, AUTHOR)
  assert.match(mail[0].payload, /Две книги/)
  assert.match(mail[0].payload, /реклама/)
})

test('повторное снятие: 409 без второй записи и второго письма', async () => {
  const item = await seedItem()
  await removeMarketItem({ actorTg: ADMIN, id: item.id, reason: 'реклама' })
  const again = await removeMarketItem({ actorTg: OTHER_ADMIN, id: item.id, reason: 'тоже реклама' })
  assert.deepEqual(again, { ok: false, code: 'already_removed' })
  assert.equal(await prisma.moderationAction.count(), 1)
  assert.equal(await prisma.notificationOutbox.count(), 1)
})

test('без причины не снимаем: её увидит автор', async () => {
  const item = await seedItem()
  const res = await removeMarketItem({ actorTg: ADMIN, id: item.id, reason: '   ' })
  assert.deepEqual(res, { ok: false, code: 'no_reason' })
  const fresh = await prisma.marketItem.findUniqueOrThrow({ where: { id: item.id } })
  assert.equal(fresh.status, 'active')
  assert.equal(await prisma.notificationOutbox.count(), 0)
})

test('неизвестное объявление — not_found', async () => {
  const res = await removeMarketItem({ actorTg: ADMIN, id: randomUUID(), reason: 'спам' })
  assert.deepEqual(res, { ok: false, code: 'not_found' })
})

test('ответом на пост: объявление находится по исходному сообщению', async () => {
  const item = await seedItem()
  const res = await removeMarketItem({ actorTg: ADMIN, sourceMsgId: 21960, reason: 'ошибка автора' })
  assert.equal(res.ok, true)
  const fresh = await prisma.marketItem.findUniqueOrThrow({ where: { id: item.id } })
  assert.equal(fresh.status, 'removed')
})

test('в журнал не попадает ничего личного сверх самой карточки', async () => {
  const item = await seedItem()
  await removeMarketItem({ actorTg: ADMIN, id: item.id, reason: 'реклама' })
  const row = await prisma.moderationAction.findFirstOrThrow()
  const meta = JSON.parse(row.meta ?? '{}')
  assert.deepEqual(Object.keys(meta).sort(), ['city', 'title'], 'только данные объявления')
  const dump = JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? String(v) : v))
  assert.doesNotMatch(dump, /seller/, 'ника автора в журнале нет')
  assert.doesNotMatch(dump, /Продавец/, 'имени автора в журнале нет')
})

/**
 * ⚠️ Честно про этот тест: на SQLite он проходит и с наивным «прочитал состояние
 * → записал», потому что база сериализует транзакции (один писатель). Он
 * фиксирует ИНВАРИАНТ — одно решение, одна запись, одно письмо, — а не механику.
 * Условный переход (`updateMany` с ожидаемым состоянием в `where`) оставлен как
 * правильный шаблон на будущее: вторая локация или Postgres такой сериализации
 * не дадут.
 */
test('два админа одновременно: одно решение, одно письмо', async () => {
  const item = await seedItem()
  const [a, b] = await Promise.all([
    removeMarketItem({ actorTg: ADMIN, id: item.id, reason: 'спам' }),
    removeMarketItem({ actorTg: OTHER_ADMIN, id: item.id, reason: 'спам' }),
  ])
  const okCount = [a, b].filter((r) => r.ok).length
  assert.equal(okCount, 1, 'снял ровно один')
  assert.equal(await prisma.moderationAction.count(), 1, 'в журнале одна запись')
  assert.equal(await prisma.notificationOutbox.count(), 1, 'автору написали один раз')
})

test('сбой записи журнала откатывает снятие', async () => {
  const item = await seedItem()
  // ломать надо на уровне БАЗЫ: внутри транзакции работает другой клиент (tx),
  // подмена prisma.moderationAction.create молча зеленела бы
  await prisma.$executeRawUnsafe('ALTER TABLE ModerationAction RENAME TO ModerationActionTmp')
  try {
    await assert.rejects(() => removeMarketItem({ actorTg: ADMIN, id: item.id, reason: 'спам' }))
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE ModerationActionTmp RENAME TO ModerationAction')
  }
  const fresh = await prisma.marketItem.findUniqueOrThrow({ where: { id: item.id } })
  assert.equal(fresh.status, 'active', 'объявление не исчезло без записи о причине')
  assert.equal(await prisma.notificationOutbox.count(), 0, 'и без письма автору')
})

/* ── ручка и витрина ──────────────────────────────────────── */

test('снятая карточка сразу исчезает из витрины', async () => {
  const item = await seedItem()
  const before = await app.inject({ method: 'GET', url: '/api/market' })
  assert.equal(before.json().length, 1)

  await removeMarketItem({ actorTg: ADMIN, id: item.id, reason: 'спам' })

  const after = await app.inject({ method: 'GET', url: '/api/market' })
  assert.equal(after.json().length, 0, 'ни карточки, ни ника, ни кнопки «Написать»')
})

test('ручка закрыта: аноним 401, обычный участник 403', async () => {
  const item = await seedItem()
  const anon = await app.inject({
    method: 'POST',
    url: `/api/admin/market/${item.id}/remove`,
    payload: { reason: 'спам' },
  })
  assert.equal(anon.statusCode, 401)

  const person = await app.inject({
    method: 'POST',
    url: `/api/admin/market/${item.id}/remove`,
    headers: asUser(AUTHOR),
    payload: { reason: 'спам' },
  })
  assert.equal(person.statusCode, 403)

  const fresh = await prisma.marketItem.findUniqueOrThrow({ where: { id: item.id } })
  assert.equal(fresh.status, 'active')
  assert.equal(await prisma.moderationAction.count(), 0)
})

test('ручка админа: 200, потом 409; пустая причина 400; чужой id 404', async () => {
  const item = await seedItem()
  const remove = (id: string, reason: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/admin/market/${id}/remove`,
      headers: asUser(ADMIN),
      payload: { reason } as any,
    })

  assert.equal((await remove(item.id, '')).statusCode, 400)
  assert.equal((await remove(randomUUID(), 'спам')).statusCode, 404)
  assert.equal((await remove(item.id, 'спам')).statusCode, 200)
  assert.equal((await remove(item.id, 'спам')).statusCode, 409)
  assert.equal(await prisma.moderationAction.count(), 1)
})
