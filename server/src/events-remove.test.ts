/**
 * Уборка прошедших встреч админом.
 *
 * Проверяется то, что делает жест безопасным: предстоящую встречу этой ручкой
 * не убрать вовсе, решение одно на два одновременных нажатия, строка остаётся
 * в базе (иначе повторный импорт темы завёл бы встречу заново), а сама уборка
 * доступна только админу — и в списке, и в снятии.
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

const DB_FILE = join(tmpdir(), `events-remove-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'
process.env.BOT_TOKEN = '123456:test-token-for-signature'
process.env.NOTION_TOKEN_V2 = ''
const ADMIN = 994001n
const OTHER_ADMIN = 994002n
const STRANGER = 994100n
process.env.ADMIN_IDS = `${ADMIN},${OTHER_ADMIN}`

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { registerRoutes } = await import('./routes.js')
const { removeEvent, listPastEvents, EVENT_TAIL_MS, PAST_WINDOW_DAYS } = await import('./events.js')

const app = Fastify()
const day = 86_400_000

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
  await prisma.event.deleteMany()
  await prisma.user.deleteMany()
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

/** Встреча со сдвигом от «сейчас»: минус — прошедшая, плюс — предстоящая. */
function seedEvent(offsetMs: number, over: Record<string, unknown> = {}) {
  return prisma.event.create({
    data: {
      city: 'Warszawa',
      title: 'Книжный обмен',
      startsAt: new Date(Date.now() + offsetMs),
      place: 'Кафе',
      source: 'topic',
      ...over,
    },
  })
}

/* ── ядро ─────────────────────────────────────────────────── */

test('прошедшая встреча убирается: мягко и с записью в журнал', async () => {
  const ev = await seedEvent(-2 * day)
  const res = await removeEvent({ actorTg: ADMIN, id: ev.id })
  assert.equal(res.ok, true)

  const fresh = await prisma.event.findUniqueOrThrow({ where: { id: ev.id } })
  assert.ok(fresh.removedAt, 'помечена снятой')
  assert.equal(fresh.title, 'Книжный обмен', 'строка на месте: физически не удаляем')

  const log = await prisma.moderationAction.findMany()
  assert.equal(log.length, 1)
  assert.equal(log[0].action, 'remove')
  assert.equal(log[0].targetType, 'event')
  assert.equal(log[0].targetId, ev.id)
  assert.equal(log[0].actorTg, ADMIN)
  assert.equal(log[0].reason, 'встреча прошла', 'причина по умолчанию: объяснять некому')
  assert.match(String(log[0].meta), /Книжный обмен/, 'по журналу решение понятно без базы')
})

test('предстоящую встречу убрать нельзя', async () => {
  const ev = await seedEvent(3 * day)
  const res = await removeEvent({ actorTg: ADMIN, id: ev.id })
  assert.equal(res.ok, false)
  assert.equal(res.ok === false && res.code, 'not_past')

  const fresh = await prisma.event.findUniqueOrThrow({ where: { id: ev.id } })
  assert.equal(fresh.removedAt, null, 'анонс, который люди уже видят, жестом не убирается')
  assert.equal((await prisma.moderationAction.count()), 0)
})

test('встреча идёт прямо сейчас — тоже не прошедшая', async () => {
  // хвост в шесть часов: встреча началась час назад и ещё идёт
  const ev = await seedEvent(-1 * 3600_000)
  const res = await removeEvent({ actorTg: ADMIN, id: ev.id })
  assert.equal(res.ok === false && res.code, 'not_past')

  // а сразу за хвостом — уже можно
  const old = await seedEvent(-EVENT_TAIL_MS - 60_000)
  assert.equal((await removeEvent({ actorTg: ADMIN, id: old.id })).ok, true)
})

test('два админа нажали одновременно: одно решение и одна запись', async () => {
  const ev = await seedEvent(-2 * day)
  const [a, b] = await Promise.all([
    removeEvent({ actorTg: ADMIN, id: ev.id }),
    removeEvent({ actorTg: OTHER_ADMIN, id: ev.id }),
  ])
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1, 'ровно один успех')
  assert.equal(await prisma.moderationAction.count(), 1, 'в журнале одна строка, а не две')
})

test('несуществующая встреча', async () => {
  const res = await removeEvent({ actorTg: ADMIN, id: 'нет-такой' })
  assert.equal(res.ok === false && res.code, 'not_found')
})

/* ── список прошедших ─────────────────────────────────────── */

test('в прошедших только прошедшие, свежие сверху', async () => {
  await seedEvent(2 * day, { title: 'Будущая' })
  await seedEvent(-1 * 3600_000, { title: 'Идёт сейчас' })
  await seedEvent(-2 * day, { title: 'Позавчера' })
  await seedEvent(-10 * day, { title: 'Давно' })

  const past = await listPastEvents()
  assert.deepEqual(
    past.map((e) => e.title),
    ['Позавчера', 'Давно'],
  )
})

test('совсем старое в блок уборки не тянем', async () => {
  await seedEvent(-(PAST_WINDOW_DAYS + 5) * day, { title: 'Прошлый год' })
  await seedEvent(-3 * day, { title: 'На днях' })
  const past = await listPastEvents()
  assert.deepEqual(past.map((e) => e.title), ['На днях'])
})

test('убранная встреча пропадает и из прошедших', async () => {
  const ev = await seedEvent(-2 * day)
  await removeEvent({ actorTg: ADMIN, id: ev.id })
  assert.equal((await listPastEvents()).length, 0)
})

/* ── что видно снаружи ────────────────────────────────────── */

test('убранная встреча пропадает из афиши', async () => {
  // встреча идёт сейчас: она в афише — и остаётся там, пока не кончится
  const ev = await seedEvent(-1 * 3600_000)
  const before = (await app.inject({ method: 'GET', url: '/api/events' })).json() as unknown[]
  assert.equal(before.length, 1)

  // а после — убираем и проверяем, что из афиши она ушла
  await prisma.event.update({
    where: { id: ev.id },
    data: { startsAt: new Date(Date.now() - 2 * day) },
  })
  await removeEvent({ actorTg: ADMIN, id: ev.id })
  await prisma.event.update({
    where: { id: ev.id },
    data: { startsAt: new Date(Date.now() - 1 * 3600_000) },
  })
  const after = (await app.inject({ method: 'GET', url: '/api/events' })).json() as unknown[]
  assert.equal(after.length, 0, 'снятое не показываем, даже пока формально идёт')
})

test('прошедшие и уборка — только админу', async () => {
  const ev = await seedEvent(-2 * day)

  const anon = await app.inject({ method: 'GET', url: '/api/admin/events/past' })
  assert.equal(anon.statusCode, 401)

  const stranger = await app.inject({
    method: 'GET',
    url: '/api/admin/events/past',
    headers: asUser(STRANGER),
  })
  assert.equal(stranger.statusCode, 403)

  const strangerRemove = await app.inject({
    method: 'POST',
    url: `/api/admin/events/${ev.id}/remove`,
    headers: asUser(STRANGER),
    payload: {},
  })
  assert.equal(strangerRemove.statusCode, 403)
  assert.equal(
    (await prisma.event.findUniqueOrThrow({ where: { id: ev.id } })).removedAt,
    null,
    'чужой запрос ничего не изменил',
  )

  const admin = await app.inject({
    method: 'GET',
    url: '/api/admin/events/past',
    headers: asUser(ADMIN),
  })
  assert.equal(admin.statusCode, 200)
  const list = admin.json() as Array<Record<string, unknown>>
  assert.equal(list.length, 1)
  assert.ok(!('createdBy' in list[0]), 'числовой tgId наружу не уходит (см. privacy.ts)')
})

test('ручка уборки: 400 на предстоящую, 409 на повторную', async () => {
  const future = await seedEvent(3 * day)
  const notPast = await app.inject({
    method: 'POST',
    url: `/api/admin/events/${future.id}/remove`,
    headers: asUser(ADMIN),
    payload: {},
  })
  assert.equal(notPast.statusCode, 400)
  assert.equal(notPast.json().error, 'not_past')

  const past = await seedEvent(-2 * day)
  const first = await app.inject({
    method: 'POST',
    url: `/api/admin/events/${past.id}/remove`,
    headers: asUser(ADMIN),
    payload: {},
  })
  assert.equal(first.statusCode, 200)

  const again = await app.inject({
    method: 'POST',
    url: `/api/admin/events/${past.id}/remove`,
    headers: asUser(ADMIN),
    payload: {},
  })
  assert.equal(again.statusCode, 409, 'повторное нажатие честно говорит, что решение уже принято')
  assert.equal(await prisma.moderationAction.count(), 1)
})

test('повторный разбор афиши не воскрешает убранную встречу', async () => {
  // ради этого удаление и мягкое: дедуп импорта идёт по sourceMsgId,
  // после физического удаления та же афиша завела бы встречу заново
  const ev = await seedEvent(-2 * day, { sourceMsgId: 555, sourceEventIndex: 0 })
  await removeEvent({ actorTg: ADMIN, id: ev.id })

  const { saveAnnouncement } = await import('./announce.js')
  const again = await saveAnnouncement(
    {
      city: 'Warszawa',
      title: 'Книжный обмен',
      startsAt: ev.startsAt,
      place: 'Кафе',
      description: null,
    },
    555,
    0,
  )
  assert.equal(again, null, 'повторный разбор не создаёт вторую встречу')
  assert.equal(await prisma.event.count(), 1)
  assert.ok(
    (await prisma.event.findUniqueOrThrow({ where: { id: ev.id } })).removedAt,
    'и не снимает пометку «убрана»',
  )
})
