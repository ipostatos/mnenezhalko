/**
 * Ручка `/api/monitor/ping` на реальном Fastify.
 *
 * Она нужна ради обратной проверки: по её отметке ВНУТРЕННЯЯ проверка видит,
 * что внешний монитор жив. Значит, важны ровно три вещи — без настройки ручки
 * нет вовсе, с чужим токеном она молчит, а с правильным оставляет время захода.
 *
 * Запуск: npm run test -w server
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import Fastify from 'fastify'

const DB_FILE = join(tmpdir(), `monitor-ping-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'
process.env.BOT_TOKEN = '123456:test-token-for-signature'
process.env.NOTION_TOKEN_V2 = ''
process.env.MONITOR_PING_TOKEN = 'test-monitor-token'

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { env } = await import('./env.js')
const { registerRoutes, MONITOR_PING_KEY, MONITOR_PING_SCHEDULE_KEY, MONITOR_PING_FIRST_KEY } =
  await import('./routes.js')

const ping = (source?: string) =>
  app.inject({
    method: 'POST',
    url: source ? `/api/monitor/ping?source=${source}` : '/api/monitor/ping',
    headers: { 'x-monitor-token': 'test-monitor-token' },
  })

const valueOf = async (key: string) =>
  (await prisma.syncState.findUnique({ where: { key } }))?.value ?? null

const app = Fastify()

before(async () => {
  await registerRoutes(app)
  await app.ready()
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

test('монитор не настроен — ручки нет вовсе (404)', async () => {
  // выключенная возможность не должна оставлять открытую точку входа
  const saved = env.monitorToken
  env.monitorToken = ''
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/monitor/ping',
      headers: { 'x-monitor-token': saved },
    })
    assert.equal(res.statusCode, 404)
  } finally {
    env.monitorToken = saved
  }
})

test('без токена в заголовке — 401, отметки нет', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/monitor/ping' })
  assert.equal(res.statusCode, 401)
  const row = await prisma.syncState.findUnique({ where: { key: MONITOR_PING_KEY } })
  assert.equal(row, null)
})

test('чужой токен — 401', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/monitor/ping',
    headers: { 'x-monitor-token': 'wrong' },
  })
  assert.equal(res.statusCode, 401)
})

test('правильный токен — 200 и время захода в SyncState', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/monitor/ping',
    headers: { 'x-monitor-token': 'test-monitor-token' },
  })
  assert.equal(res.statusCode, 200)
  const row = await prisma.syncState.findUnique({ where: { key: MONITOR_PING_KEY } })
  assert.ok(row, 'отметка должна появиться')
  const age = Date.now() - new Date(row!.value).getTime()
  assert.ok(age >= 0 && age < 60_000, `время захода должно быть свежим, получено ${row!.value}`)
})

test('ручной прогон НЕ обновляет отметку расписания', async () => {
  // иначе один ручной прогон раз в месяц маскировал бы выключенное расписание —
  // ровно ту дыру, ради которой отметка и заводилась
  await ping('schedule')
  const sched = await valueOf(MONITOR_PING_SCHEDULE_KEY)
  assert.ok(sched, 'заход по расписанию должен отметиться')

  await new Promise((r) => setTimeout(r, 5))
  const res = await ping('manual')
  assert.equal(res.json().source, 'manual')
  assert.equal(await valueOf(MONITOR_PING_SCHEDULE_KEY), sched, 'отметка расписания не должна двигаться')
  assert.notEqual(await valueOf(MONITOR_PING_KEY), sched, 'общая отметка должна обновиться')
})

test('источник без имени и незнакомый источник считаются ручными', async () => {
  const before = await valueOf(MONITOR_PING_SCHEDULE_KEY)
  assert.equal((await ping()).json().source, 'manual')
  assert.equal((await ping('cron-like-nonsense')).json().source, 'manual')
  assert.equal(await valueOf(MONITOR_PING_SCHEDULE_KEY), before)
})

test('время первого захода не переписывается никогда', async () => {
  // это точка отсчёта «сколько уже молчит расписание»: сдвинется она —
  // и «расписание не работает вторые сутки» навсегда останется «только настроили»
  const first = await valueOf(MONITOR_PING_FIRST_KEY)
  assert.ok(first)
  await new Promise((r) => setTimeout(r, 5))
  await ping('schedule')
  assert.equal(await valueOf(MONITOR_PING_FIRST_KEY), first)
})

test('повторный заход обновляет ту же строку, а не плодит новые', async () => {
  const before = await prisma.syncState.findUnique({ where: { key: MONITOR_PING_KEY } })
  await new Promise((r) => setTimeout(r, 5))
  await app.inject({
    method: 'POST',
    url: '/api/monitor/ping',
    headers: { 'x-monitor-token': 'test-monitor-token' },
  })
  const after = await prisma.syncState.findMany({ where: { key: MONITOR_PING_KEY } })
  assert.equal(after.length, 1)
  assert.notEqual(after[0].value, before!.value)
})
