/**
 * Опознание человека для админских команд и сводка проекта.
 *
 * Главное здесь — что решение принимается не вслепую: команда понимает «@ник»
 * так же, как числовой id, честно отличает «человека нет» от «есть в
 * справочнике, но бота не открывал», и показывает действующие ограничения
 * до того, как админ поставит новое.
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

const DB_FILE = join(tmpdir(), `admin-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'
process.env.BOT_TOKEN = '123456:test-token-for-signature'
process.env.NOTION_TOKEN_V2 = ''
const ADMIN = 995001n
process.env.ADMIN_IDS = String(ADMIN)

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { findPerson, personCard, projectStats } = await import('./admin.js')
const { restrictUser } = await import('./moderation.js')

const READER = 995010n
const day = 86_400_000

before(async () => {})

beforeEach(async () => {
  await prisma.userRestriction.deleteMany()
  await prisma.notificationOutbox.deleteMany()
  await prisma.moderationAction.deleteMany()
  await prisma.review.deleteMany()
  await prisma.loan.deleteMany()
  await prisma.book.deleteMany()
  await prisma.librarian.deleteMany()
  await prisma.event.deleteMany()
  await prisma.marketItem.deleteMany()
  await prisma.user.deleteMany()
})

after(async () => {
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

/* ── опознание ────────────────────────────────────────────── */

test('по @нику, без собачки и в любом регистре', async () => {
  await prisma.user.create({ data: { tgId: READER, username: 'Marina_K', firstName: 'Марина' } })

  for (const input of ['@Marina_K', 'Marina_K', 'marina_k', '@MARINA_K', ' @marina_k ']) {
    const res = await findPerson(input)
    assert.equal(res.ok, true, `не опознан: ${input}`)
    assert.equal(res.ok && res.person.tgId, READER)
  }
})

test('по числовому id — и когда человек уже в базе, и когда ещё нет', async () => {
  await prisma.user.create({ data: { tgId: READER, username: 'marina', firstName: 'Марина' } })
  const known = await findPerson(String(READER))
  assert.equal(known.ok && known.person.firstName, 'Марина')

  // id может прийти из журнала решений, а самого человека в базе уже нет:
  // отказывать в решении из-за этого нельзя
  const unknown = await findPerson('995999')
  assert.equal(unknown.ok, true)
  assert.equal(unknown.ok && unknown.person.tgId, 995999n)
})

test('библиотекарь из Notion, который не открывал бота', async () => {
  await prisma.librarian.create({
    data: { name: 'Лиза', telegram: '@LizavetaZh', telegramNorm: 'lizavetazh', city: 'Warszawa' },
  })
  const res = await findPerson('@LizavetaZh')
  assert.equal(res.ok, false)
  assert.equal(res.ok === false && res.code, 'known_but_no_tg', 'это не «нет такого», а «нечем опознать»')
  assert.equal(res.ok === false && res.name, 'Лиза')
})

test('библиотекарь, который бота открывал, опознаётся по нику из Notion', async () => {
  await prisma.user.create({ data: { tgId: READER, username: null, firstName: 'Лиза' } })
  await prisma.librarian.create({
    data: { name: 'Лиза', telegram: '@LizavetaZh', telegramNorm: 'lizavetazh', tgId: READER },
  })
  const res = await findPerson('@LizavetaZh')
  assert.equal(res.ok && res.person.tgId, READER)
})

test('незнакомый ник и то, что ником быть не может', async () => {
  assert.equal(((await findPerson('@unknown_person')) as any).code, 'not_found')
  assert.equal(((await findPerson('   ')) as any).code, 'empty')
  // ников кириллицей в Telegram не бывает: такой ввод — не «не нашли»,
  // а «это вообще не ник», и админу надо сказать именно это
  assert.equal(((await findPerson('@нет_такого')) as any).code, 'empty')
})

/* ── карточка ─────────────────────────────────────────────── */

test('карточка: полка, выдачи, отзывы и действующие ограничения', async () => {
  await prisma.user.create({ data: { tgId: READER, username: 'marina', firstName: 'Марина' } })
  const lib = await prisma.librarian.create({ data: { name: 'Марина', tgId: READER, city: 'Kraków' } })
  await prisma.book.createMany({
    data: [
      { title: 'Книга 1', ownerId: lib.id, search: 'книга 1' },
      { title: 'Книга 2', ownerId: lib.id, search: 'книга 2' },
      // неодобренная в счёт полки не идёт: в каталоге её нет
      { title: 'На проверке', ownerId: lib.id, search: 'на проверке', reviewStatus: 'pending' },
    ],
  })
  await prisma.loan.create({ data: { title: 'Отданная', ownerTg: READER } })
  await prisma.review.create({ data: { workKey: 'к|а', authorTg: READER, rating: 5 } })
  await restrictUser({
    actorTg: ADMIN,
    targetTg: READER,
    scope: 'reviews',
    reason: 'грубость',
    days: 7,
  })

  const found = await findPerson('@marina')
  assert.equal(found.ok, true)
  const card = await personCard((found as any).person)

  assert.equal(card.librarian?.books, 2)
  assert.equal(card.loansGiven, 1)
  assert.equal(card.reviews, 1)
  assert.equal(card.isAdmin, false)
  assert.equal(card.restrictions.length, 1)
  assert.equal(card.restrictions[0].title, 'оценки и отзывы', 'область названа по-человечески')
  assert.ok(card.restrictions[0].until, 'срок виден: бессрочное и временное различаются')
})

test('снятое и истёкшее ограничение в карточке не показывается', async () => {
  await prisma.user.create({ data: { tgId: READER, username: 'marina', firstName: 'Марина' } })
  await prisma.userRestriction.create({
    data: { userTg: READER, scope: 'ai', reason: 'старое', createdByTg: ADMIN, liftedAt: new Date() },
  })
  await prisma.userRestriction.create({
    data: {
      userTg: READER,
      scope: 'market',
      reason: 'истекло',
      createdByTg: ADMIN,
      expiresAt: new Date(Date.now() - day),
    },
  })
  const found = await findPerson('@marina')
  const card = await personCard((found as any).person)
  assert.equal(card.restrictions.length, 0)
})

test('карточка админа помечена как админская', async () => {
  await prisma.user.create({ data: { tgId: ADMIN, username: 'boss', firstName: 'Админ' } })
  const found = await findPerson('@boss')
  const card = await personCard((found as any).person)
  assert.equal(card.isAdmin, true)
})

/* ── сводка ───────────────────────────────────────────────── */

test('сводка считает то, что требует внимания', async () => {
  await prisma.user.create({ data: { tgId: READER, username: 'marina', firstName: 'Марина' } })
  const lib = await prisma.librarian.create({ data: { name: 'Марина', tgId: READER } })
  await prisma.book.createMany({
    data: [
      { title: 'В каталоге', ownerId: lib.id, search: 'в каталоге' },
      { title: 'Ждёт проверки', ownerId: lib.id, search: 'ждёт', reviewStatus: 'pending' },
    ],
  })
  await prisma.loan.create({
    data: { title: 'Просроченная', ownerTg: READER, dueAt: new Date(Date.now() - day) },
  })
  await prisma.event.create({
    data: { city: 'Warszawa', title: 'Будущая', startsAt: new Date(Date.now() + day) },
  })
  await prisma.event.create({
    data: {
      city: 'Warszawa',
      title: 'Убранная',
      startsAt: new Date(Date.now() + 2 * day),
      removedAt: new Date(),
    },
  })

  const s = await projectStats()
  assert.equal(s.books, 1, 'книга на проверке в каталог не считается')
  assert.equal(s.pendingBooks, 1)
  assert.equal(s.activeLoans, 1)
  assert.equal(s.overdueLoans, 1)
  assert.equal(s.events, 1, 'убранная встреча в предстоящих не считается')
  assert.equal(s.librarians, 1)
})
