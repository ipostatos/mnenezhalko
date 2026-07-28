/**
 * Тесты персистентного планировщика фоновых джоб (аудит 2026-07-28, P0.1):
 * голый setInterval от старта процесса ни разу не дал напоминаниям отработать —
 * теперь отсчёт идёт от последнего успешного прогона в базе.
 * Запуск: npm run test -w server
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `sched-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { nextJobDelayMs, jobRetryDelayMs, runJobOnce, readJobState, JOB_BOOT_DELAY_MS } =
  await import('./scheduler.js')

const HOUR = 3600_000
const DAY = 24 * HOUR
const NOW = Date.parse('2026-07-28T12:00:00Z')
const quiet = { log: () => {}, logError: () => {} }

after(async () => {
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

test('джоба ещё не бегала — первый прогон сразу после загрузочной паузы', () => {
  assert.equal(nextJobDelayMs(null, NOW, DAY), JOB_BOOT_DELAY_MS)
})

test('рестарт до истечения периода не сбрасывает отсчёт', () => {
  const last = new Date(NOW - 2 * HOUR).toISOString()
  // «рестарт» = пересчёт от той же метки: осталось ровно 22 часа, не 24
  assert.equal(nextJobDelayMs(last, NOW, DAY), 22 * HOUR)
})

test('просроченная джоба выполняется сразу после рестарта', () => {
  const last = new Date(NOW - 30 * HOUR).toISOString()
  assert.equal(nextJobDelayMs(last, NOW, DAY), JOB_BOOT_DELAY_MS)
})

test('битая или будущая метка не блокирует джобу навсегда', () => {
  assert.equal(nextJobDelayMs('мусор', NOW, DAY), JOB_BOOT_DELAY_MS)
  assert.equal(nextJobDelayMs(new Date(NOW + DAY).toISOString(), NOW, DAY), JOB_BOOT_DELAY_MS)
})

test('повтор после ошибки — растущая пауза, не длиннее периода', () => {
  const base = 5 * 60_000
  assert.equal(jobRetryDelayMs(1, DAY), base)
  assert.equal(jobRetryDelayMs(2, DAY), base * 2)
  assert.equal(jobRetryDelayMs(3, DAY), base * 4)
  // и никогда не дольше самого периода (иначе повтор «позже планового»)
  assert.equal(jobRetryDelayMs(20, 6 * HOUR), 6 * HOUR)
})

test('успешный прогон записывает lastSuccessAt/lastCompletedAt и чистит ошибку', async () => {
  const r = await runJobOnce({ name: 't-ok', periodMs: DAY, run: async () => 'всё хорошо', ...quiet })
  assert.equal(r.ok, true)
  assert.ok(await readJobState('t-ok', 'lastStartedAt'))
  assert.ok(await readJobState('t-ok', 'lastSuccessAt'))
  assert.ok(await readJobState('t-ok', 'lastCompletedAt'))
  assert.equal(await readJobState('t-ok', 'lastError'), '')
})

test('упавший прогон фиксирует ошибку и НЕ двигает lastSuccessAt', async () => {
  await runJobOnce({ name: 't-fail', periodMs: DAY, run: async () => 'ок', ...quiet })
  const successBefore = await readJobState('t-fail', 'lastSuccessAt')
  const r = await runJobOnce({
    name: 't-fail',
    periodMs: DAY,
    run: async () => {
      throw new Error('telegram down')
    },
    ...quiet,
  })
  assert.equal(r.ok, false)
  assert.equal(await readJobState('t-fail', 'lastSuccessAt'), successBefore)
  assert.match((await readJobState('t-fail', 'lastError')) ?? '', /telegram down/)
})

test('ошибка джобы не пробрасывается наружу (не роняет сервер)', async () => {
  // никакого try/catch вокруг — упавший run не должен реджектить runJobOnce
  const r = await runJobOnce({
    name: 't-throw',
    periodMs: DAY,
    run: async () => {
      throw new Error('boom')
    },
    ...quiet,
  })
  assert.equal(r.ok, false)
})

test('одна джоба не идёт в два потока: параллельный запуск пропускается', async () => {
  let runs = 0
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const def = {
    name: 't-overlap',
    periodMs: DAY,
    run: async () => {
      runs++
      await gate
    },
    ...quiet,
  }
  const first = runJobOnce(def)
  const second = await runJobOnce(def) // пока первый висит внутри run
  assert.equal(second.skipped, true)
  release()
  await first
  assert.equal(runs, 1)
})

test('после рестарта отсчёт housekeeping идёт от сохранённого времени', async () => {
  // прогнали джобу, «перезапустились» — nextJobDelayMs читает то, что в базе
  await runJobOnce({ name: 't-persist', periodMs: 6 * HOUR, run: async () => {}, ...quiet })
  const last = await readJobState('t-persist', 'lastSuccessAt')
  assert.ok(last)
  const delay = nextJobDelayMs(last, Date.parse(last!) + HOUR, 6 * HOUR)
  assert.equal(delay, 5 * HOUR) // не полные 6 часов заново
})
