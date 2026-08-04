/**
 * Админ вносит книгу ЗА библиотекаря из Mini App (просьба user 4.08.2026).
 *
 * Раньше этого не было вовсе: человек, который не может внести книги сам,
 * просил админа — и книги оседали на полке админа, номинально становясь его.
 * В боте есть `/onbehalf @ник`, но в приложении владельца было не выбрать.
 *
 * Проверяем ровно то, что делает эту функцию правильной, а не просто рабочей:
 * книга принадлежит человеку (а не тому, кто вносил), город берётся у него,
 * след «кто внёс» остаётся, обычный участник чужой полкой распоряжаться не
 * может, а несуществующий владелец — отказ, а не тихая посадка на свою полку.
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

const DB_FILE = join(tmpdir(), `onbehalf-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'
process.env.BOT_TOKEN = '123456:test-token-for-signature'
process.env.NOTION_TOKEN_V2 = '' // общая таблица выключена — сеть не трогаем
const ADMIN = 992001n
const PERSON = 992002n // обычный участник
process.env.ADMIN_IDS = String(ADMIN)

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { registerRoutes } = await import('./routes.js')

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

const addBook = (body: Record<string, unknown>, tgId: bigint | null = ADMIN) =>
  app.inject({
    method: 'POST',
    url: '/api/books',
    headers: tgId === null ? {} : asUser(tgId),
    payload: body,
  })

/** Библиотекарь, который сам книги внести не может: есть в базе из Notion. */
async function seedLibrarian(over: Record<string, unknown> = {}) {
  return prisma.librarian.create({
    data: {
      name: 'Мария Ковальская',
      telegram: 'maria_k',
      telegramNorm: 'maria_k',
      city: 'Kraków',
      ...over,
    },
  })
}

before(async () => {
  await registerRoutes(app)
  await app.ready()
})

beforeEach(async () => {
  await prisma.book.deleteMany()
  await prisma.librarian.deleteMany()
  await prisma.user.deleteMany()
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

test('книга встаёт на полку человека, а не того, кто её вносит', async () => {
  const lib = await seedLibrarian()

  const r = await addBook({ title: 'Солярис', author: 'Станислав Лем', ownerLibrarianId: lib.id })
  assert.equal(r.statusCode, 200)
  assert.equal(r.json().onBehalf.name, 'Мария Ковальская')

  const book = await prisma.book.findFirstOrThrow({ where: { title: 'Солярис' } })
  assert.equal(book.ownerId, lib.id)
  // след остаётся: видно, что карточку завёл админ, а книга не его
  assert.equal(book.addedByTg, ADMIN)
  // у админа своей полки от этого не появилось
  assert.equal(await prisma.librarian.count({ where: { tgId: ADMIN } }), 0)
})

test('город берётся у владельца, а не у того, кто вносит', async () => {
  const lib = await seedLibrarian({ city: 'Poznań' })
  await addBook({ title: 'Дюна', ownerLibrarianId: lib.id })

  const book = await prisma.book.findFirstOrThrow({ where: { title: 'Дюна' } })
  assert.equal(book.city, 'Poznań')
})

test('без выбора владельца всё работает как раньше: книга своя', async () => {
  const r = await addBook({ title: 'Мастер и Маргарита', city: 'Warszawa' })
  assert.equal(r.statusCode, 200)
  assert.equal(r.json().onBehalf, null)

  const book = await prisma.book.findFirstOrThrow({ where: { title: 'Мастер и Маргарита' } })
  const mine = await prisma.librarian.findFirstOrThrow({ where: { tgId: ADMIN } })
  assert.equal(book.ownerId, mine.id)
})

test('обычный участник чужой полкой распоряжаться не может', async () => {
  const lib = await seedLibrarian()
  const r = await addBook({ title: 'Чужая книга', ownerLibrarianId: lib.id }, PERSON)
  assert.equal(r.statusCode, 403)
  assert.equal(await prisma.book.count(), 0)
})

test('несуществующий владелец — отказ, а не тихая посадка на свою полку', async () => {
  const r = await addBook({ title: 'Ничья книга', ownerLibrarianId: 'нет-такого-id' })
  assert.equal(r.statusCode, 404)
  assert.equal(r.json().error, 'librarian_not_found')
  assert.equal(await prisma.book.count(), 0)
})

test('слитый дубль библиотекаря владельцем быть не может', async () => {
  const main = await seedLibrarian()
  const dupe = await seedLibrarian({
    name: 'Мария Ковальская (дубль)',
    telegram: null,
    telegramNorm: null,
    mergedIntoId: main.id,
  })

  const r = await addBook({ title: 'Книга в дубль', ownerLibrarianId: dupe.id })
  assert.equal(r.statusCode, 404)
})

/* ── поиск библиотекаря для этого выбора ─────────────────── */

const search = (q: string, tgId: bigint | null = ADMIN) =>
  app.inject({
    method: 'GET',
    url: `/api/admin/librarians?q=${encodeURIComponent(q)}`,
    headers: tgId === null ? {} : asUser(tgId),
  })

test('ищем и по нику, и по имени — в проекте есть библиотекари без ника', async () => {
  await seedLibrarian()
  await seedLibrarian({ name: 'Пётр Без Ника', telegram: null, telegramNorm: null, city: 'Łódź' })

  const byNick = await search('maria')
  assert.equal(byNick.json().librarians[0].name, 'Мария Ковальская')

  const byName = await search('Пётр')
  assert.equal(byName.json().librarians.length, 1)
  assert.equal(byName.json().librarians[0].telegram, null)
})

test('регистр и @ значения не имеют — ник вводят как придётся', async () => {
  await seedLibrarian()
  for (const q of ['@MARIA_K', 'МАРИЯ', 'ковальская']) {
    const r = await search(q)
    assert.equal(r.json().librarians.length, 1, `не нашёл по «${q}»`)
  }
})

test('справочник библиотекарей закрыт: не админ — 403, аноним — 401', async () => {
  await seedLibrarian()
  assert.equal((await search('maria', PERSON)).statusCode, 403)
  assert.equal((await search('maria', null)).statusCode, 401)
})

test('дубли-однофамильцы: первым идёт тот, у кого книги есть', async () => {
  const empty = await seedLibrarian({ name: 'Анна', telegram: null, telegramNorm: null })
  const active = await seedLibrarian({ name: 'Анна', telegram: null, telegramNorm: null })
  await prisma.book.create({
    data: { title: 'Её книга', ownerId: active.id, addedByTg: ADMIN, source: 'bot' },
  })

  const r = await search('Анна')
  const ids = r.json().librarians.map((l: { id: string }) => l.id)
  assert.deepEqual(ids, [active.id, empty.id])
})

test('дубль книги считается по полке ВЛАДЕЛЬЦА, а не того, кто вносит', async () => {
  const lib = await seedLibrarian()
  await addBook({ title: 'Солярис', ownerLibrarianId: lib.id })

  const r = await app.inject({
    method: 'GET',
    url: `/api/duplicates?title=${encodeURIComponent('Солярис')}&ownerLibrarianId=${lib.id}`,
    headers: asUser(ADMIN),
  })
  assert.equal(r.json().own?.title, 'Солярис')

  // без указания владельца это уже не «свой» дубль — админ такую книгу не ставил
  const mine = await app.inject({
    method: 'GET',
    url: `/api/duplicates?title=${encodeURIComponent('Солярис')}`,
    headers: asUser(ADMIN),
  })
  assert.equal(mine.json().own, null)
})
