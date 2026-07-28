/**
 * P1.2 аудита 2026-07-28: варшавское время без захардкоженного +02:00 и
 * несколько встреч из одного сообщения афиши (дедуп по (msgId, index)).
 * Запуск: npm run test -w server
 */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `announce-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { saveAnnouncement } = await import('./announce.js')
const { warsawTime, warsawOffsetMs } = await import('./time.js')

beforeEach(async () => {
  await prisma.event.deleteMany()
})

after(async () => {
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

/* ── варшавское время ── */

test('лето (CEST): 19:00 в Варшаве = 17:00 UTC', () => {
  assert.equal(warsawTime('2026-07-15', '19:00').toISOString(), '2026-07-15T17:00:00.000Z')
})

test('зима (CET): 19:00 в Варшаве = 18:00 UTC — раньше тут был сдвиг на час', () => {
  assert.equal(warsawTime('2026-12-15', '19:00').toISOString(), '2026-12-15T18:00:00.000Z')
})

test('дни вокруг перехода на зимнее время (2026-10-25) считаются каждым своим смещением', () => {
  // суббота до перевода — ещё CEST (+2), понедельник после — уже CET (+1)
  assert.equal(warsawTime('2026-10-24', '19:00').toISOString(), '2026-10-24T17:00:00.000Z')
  assert.equal(warsawTime('2026-10-26', '19:00').toISOString(), '2026-10-26T18:00:00.000Z')
})

test('несуществующее время весеннего скачка не даёт NaN и остаётся в разумном окне', () => {
  // 2026-03-29 02:30 по Варшаве не существует (02:00 → 03:00)
  const t = warsawTime('2026-03-29', '02:30')
  assert.ok(Number.isFinite(t.getTime()))
  const off = warsawOffsetMs(t)
  assert.ok(off === 3600_000 || off === 7200_000)
})

/* ── несколько встреч из одного сообщения ── */

const ev = (title: string, iso: string, city = 'Warszawa') => ({
  city,
  startsAt: new Date(iso),
  title,
  place: null,
  description: null,
})

test('три встречи из одного сообщения сохраняются все', async () => {
  const msgId = 1001
  const events = [
    ev('Обмен книгами', '2026-08-01T17:00:00Z'),
    ev('Книжный клуб', '2026-08-08T17:00:00Z'),
    ev('Пикник с книгами', '2026-08-15T17:00:00Z', 'Kraków'),
  ]
  for (const [i, e] of events.entries()) {
    const created = await saveAnnouncement(e, msgId, i)
    assert.ok(created, `встреча №${i + 1} должна сохраниться`)
  }
  assert.equal(await prisma.event.count(), 3)
})

test('повторный разбор того же сообщения не создаёт дублей', async () => {
  const msgId = 1002
  const events = [ev('A', '2026-08-01T17:00:00Z'), ev('B', '2026-08-08T17:00:00Z')]
  for (const [i, e] of events.entries()) await saveAnnouncement(e, msgId, i)
  for (const [i, e] of events.entries()) {
    const again = await saveAnnouncement(e, msgId, i)
    assert.equal(again, null, 'повтор не должен создать запись (и не шлёт алерт)')
  }
  assert.equal(await prisma.event.count(), 2)
})

test('правка второй встречи в сообщении обновляет ИМЕННО её', async () => {
  const msgId = 1003
  await saveAnnouncement(ev('Первая', '2026-08-01T17:00:00Z'), msgId, 0)
  await saveAnnouncement(ev('Вторая', '2026-08-08T17:00:00Z'), msgId, 1)
  // афишу отредактировали: у второй встречи новое место и время
  const edited = { ...ev('Вторая', '2026-08-08T18:00:00Z'), place: 'Кафе «Клумба»' }
  const r = await saveAnnouncement(edited, msgId, 1)
  assert.equal(r, null, 'обновление не считается новой встречей')
  const rows = await prisma.event.findMany({ orderBy: { startsAt: 'asc' } })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].title, 'Первая')
  assert.equal(rows[1].place, 'Кафе «Клумба»')
  assert.equal(rows[1].startsAt.toISOString(), '2026-08-08T18:00:00.000Z')
})

test('встреча, уже заведённая админом руками, не дублируется афишей', async () => {
  await prisma.event.create({
    data: { city: 'Warszawa', title: 'Обмен', startsAt: new Date('2026-08-01T17:00:00Z'), source: 'admin' },
  })
  const r = await saveAnnouncement(ev('Обмен', '2026-08-01T17:00:00Z'), 1004, 0)
  assert.equal(r, null)
  assert.equal(await prisma.event.count(), 1)
})
