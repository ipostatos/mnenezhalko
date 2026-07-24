/**
 * Тесты напоминаний по просроченным выдачам (issue #7).
 * Запуск: npm run test -w server
 *
 * Самодостаточно: заводит временную SQLite-базу через `prisma db push`, сеет
 * выдачи в нужных состояниях, гоняет ядро с инъекцией времени (`now`) и фейковым
 * адаптером отправки — без реального Telegram и без ожидания месяца.
 */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `rem-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { runOverdueReminders, markReturned, reopenLoan } = await import('./loans.js')

const DAY = 86_400_000
const NOW = new Date('2026-07-24T12:00:00Z')

/** Фейковый адаптер: собирает отправленное; можно заставить падать на chatId. */
function collector(failOn?: string) {
  const sent: { chatId: string; text: string }[] = []
  const send = async (chatId: string, text: string) => {
    if (failOn && chatId === failOn) throw new Error('telegram down')
    sent.push({ chatId, text })
  }
  return { sent, send }
}

async function seedLoan(o: {
  title: string
  ownerTg: bigint
  holderTg?: bigint | null
  holderUsername?: string | null
  takenAt: Date
  dueAt: Date | null
  remindedAt?: Date | null
  status?: string
  returnedAt?: Date | null
}) {
  await prisma.user.upsert({ where: { tgId: o.ownerTg }, create: { tgId: o.ownerTg }, update: {} })
  if (o.holderTg)
    await prisma.user.upsert({ where: { tgId: o.holderTg }, create: { tgId: o.holderTg }, update: {} })
  return prisma.loan.create({
    data: {
      title: o.title,
      ownerTg: o.ownerTg,
      holderTg: o.holderTg ?? null,
      holderUsername: o.holderUsername ?? null,
      takenAt: o.takenAt,
      dueAt: o.dueAt,
      remindedAt: o.remindedAt ?? null,
      status: o.status ?? 'active',
      returnedAt: o.returnedAt ?? null,
    },
  })
}

const run = (c: ReturnType<typeof collector>) =>
  runOverdueReminders({ send: c.send, botUsername: 'testbot', now: NOW })

beforeEach(async () => {
  await prisma.loanEvent.deleteMany({})
  await prisma.loan.deleteMany({})
  await prisma.user.deleteMany({})
})

after(async () => {
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

test('1. выдача без срока — не напоминаем', async () => {
  await seedLoan({ title: 'A', ownerTg: 1n, holderTg: 2n, takenAt: new Date(NOW.getTime() - 40 * DAY), dueAt: null })
  const c = collector()
  const r = await run(c)
  assert.equal(r.loans, 0)
  assert.equal(c.sent.length, 0)
})

test('2. срок ещё не наступил — не напоминаем', async () => {
  await seedLoan({ title: 'B', ownerTg: 1n, holderTg: 2n, takenAt: new Date(NOW.getTime() - 5 * DAY), dueAt: new Date(NOW.getTime() + 5 * DAY) })
  const c = collector()
  const r = await run(c)
  assert.equal(r.loans, 0)
  assert.equal(c.sent.length, 0)
})

test('3. срок наступил — владелец уведомлён', async () => {
  await seedLoan({ title: 'C', ownerTg: 10n, holderTg: null, holderUsername: 'reader', takenAt: new Date(NOW.getTime() - 40 * DAY), dueAt: new Date(NOW.getTime() - DAY) })
  const c = collector()
  const r = await run(c)
  assert.equal(r.loans, 1)
  assert.ok(c.sent.some((m) => m.chatId === '10'), 'владелец должен получить сообщение')
})

test('4. читатель в боте — уведомление обеим сторонам', async () => {
  await seedLoan({ title: 'D', ownerTg: 20n, holderTg: 21n, holderUsername: 'anna', takenAt: new Date(NOW.getTime() - 40 * DAY), dueAt: new Date(NOW.getTime() - 2 * DAY) })
  const c = collector()
  await run(c)
  assert.ok(c.sent.some((m) => m.chatId === '21'), 'читатель уведомлён')
  const owner = c.sent.find((m) => m.chatId === '20')
  assert.ok(owner, 'владелец уведомлён')
  assert.match(owner!.text, /напомнил читателю/)
})

test('5. читатель не в боте — владельцу инструкция с invite-ссылкой', async () => {
  const loan = await seedLoan({ title: 'E', ownerTg: 30n, holderTg: null, holderUsername: 'ghost', takenAt: new Date(NOW.getTime() - 40 * DAY), dueAt: new Date(NOW.getTime() - DAY) })
  const c = collector()
  await run(c)
  assert.equal(c.sent.length, 1)
  assert.equal(c.sent[0].chatId, '30')
  assert.match(c.sent[0].text, new RegExp(`\\?start=loan_${loan.id}`))
})

test('6. повторный прогон в течение 7 дней — без дублей', async () => {
  await seedLoan({ title: 'F', ownerTg: 40n, holderTg: 41n, takenAt: new Date(NOW.getTime() - 40 * DAY), dueAt: new Date(NOW.getTime() - 10 * DAY), remindedAt: new Date(NOW.getTime() - 3 * DAY) })
  const c = collector()
  const r = await run(c)
  assert.equal(r.loans, 0)
  assert.equal(c.sent.length, 0)
})

test('7. спустя 7 дней — повторное напоминание', async () => {
  await seedLoan({ title: 'G', ownerTg: 50n, holderTg: 51n, takenAt: new Date(NOW.getTime() - 40 * DAY), dueAt: new Date(NOW.getTime() - 10 * DAY), remindedAt: new Date(NOW.getTime() - 8 * DAY) })
  const c = collector()
  const r = await run(c)
  assert.equal(r.loans, 1)
  assert.ok(c.sent.some((m) => m.chatId === '50'))
})

test('8. после возврата — не напоминаем', async () => {
  const loan = await seedLoan({ title: 'H', ownerTg: 60n, holderTg: 61n, takenAt: new Date(NOW.getTime() - 40 * DAY), dueAt: new Date(NOW.getTime() - 5 * DAY) })
  await markReturned(loan.id, 60n)
  const c = collector()
  const r = await run(c)
  assert.equal(r.loans, 0)
  assert.equal(c.sent.length, 0)
})

test('9. после отмены возврата (undo) — напоминания снова работают', async () => {
  const loan = await seedLoan({ title: 'I', ownerTg: 70n, holderTg: 71n, takenAt: new Date(NOW.getTime() - 40 * DAY), dueAt: new Date(NOW.getTime() - 5 * DAY) })
  await markReturned(loan.id, 70n)
  const back = collector()
  assert.equal((await run(back)).loans, 0) // пока возвращена — молчим
  const re = await reopenLoan(loan.id, 70n)
  assert.ok('loan' in re, 'undo должен пройти')
  const c = collector()
  const r = await run(c)
  assert.equal(r.loans, 1)
  assert.ok(c.sent.some((m) => m.chatId === '70'))
})

test('10. ошибка отправки одному не срывает рассылку остальным', async () => {
  await seedLoan({ title: 'J1', ownerTg: 101n, holderTg: 100n, takenAt: new Date(NOW.getTime() - 40 * DAY), dueAt: new Date(NOW.getTime() - DAY) })
  await seedLoan({ title: 'J2', ownerTg: 201n, holderTg: 200n, takenAt: new Date(NOW.getTime() - 40 * DAY), dueAt: new Date(NOW.getTime() - DAY) })
  const c = collector('100') // падаем на первом читателе
  const r = await run(c)
  assert.equal(r.loans, 2)
  assert.equal(r.failed, 1)
  assert.equal(r.sent, 3)
  // остальные получатели всё равно уведомлены
  for (const id of ['101', '200', '201']) assert.ok(c.sent.some((m) => m.chatId === id), `нет сообщения ${id}`)
  // обе выдачи помечены напомненными, несмотря на сбой
  const notReminded = await prisma.loan.count({ where: { remindedAt: null } })
  assert.equal(notReminded, 0)
})
