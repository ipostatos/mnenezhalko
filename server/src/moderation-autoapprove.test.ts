/**
 * Модерация книг: что видит обычный участник и что — администратор (A2, ТЗ 5.08.2026).
 *
 * ПОВОД. Участница добавила книгу, и книга сразу оказалась в каталоге — возник
 * вопрос, работает ли модерация вообще. Проверка на проде показала: MODERATION_ON=1,
 * а книгу вносил АДМИН (в администраторах у нас 4 человека). То есть сработало
 * задокументированное правило «админ публикует сам», а не отключённая проверка.
 * Правило мы не меняем — но интерфейс обязан назвать причину вслух, иначе
 * мгновенная публикация неотличима от поломки.
 *
 * Поэтому тест закрепляет ровно три исхода и то, что каталог им соответствует:
 * обычный участник → pending и книги в каталоге НЕТ; админ → published/admin с
 * объяснением; модерация выключена → published/moderation_off и объяснять нечего.
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

const DB_FILE = join(tmpdir(), `modauto-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'
process.env.BOT_TOKEN = '123456:test-token-for-signature'
process.env.NOTION_TOKEN_V2 = '' // общая таблица выключена — сеть не трогаем
process.env.MODERATION_ON = '1' // env.ts читает окружение при импорте
const ADMIN = 993001n
const PERSON = 993002n
process.env.ADMIN_IDS = String(ADMIN)

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { env } = await import('./env.js')
const { registerRoutes } = await import('./routes.js')
const { moderationNotice } = await import('./publish.js')

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

const addBook = (title: string, tgId: bigint) =>
  app.inject({ method: 'POST', url: '/api/books', headers: asUser(tgId), payload: { title } })

const myShelf = (tgId: bigint) =>
  app.inject({ method: 'GET', url: '/api/my-shelf', headers: asUser(tgId) })

before(async () => {
  await registerRoutes(app)
  await app.ready()
})

beforeEach(async () => {
  await prisma.book.deleteMany()
  await prisma.librarian.deleteMany()
  await prisma.user.deleteMany()
  env.moderation = true // предыдущий тест мог выключить (см. ниже)
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

test('обычный участник при включённой модерации: книга уходит на проверку и в каталог не попадает', async () => {
  const res = await addBook('Книга обычного участника', PERSON)
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.book.reviewStatus, 'pending')
  assert.deepEqual(body.moderation, { state: 'pending' })
  assert.match(body.moderationNotice, /на проверку модератору/i)

  // каталог — главная проверка: обещание «не попадёт в библиотеку» должно
  // выполняться на данных, а не только в статусе
  const found = await app.inject({ method: 'GET', url: '/api/books?q=обычного участника' })
  assert.equal(found.json().total, 0, 'книга на проверке не должна быть в каталоге')
})

test('администратор при включённой модерации: книга публикуется сразу И это объяснено', async () => {
  const res = await addBook('Книга администратора', ADMIN)
  const body = res.json()
  assert.equal(body.book.reviewStatus, 'approved')
  assert.deepEqual(body.moderation, { state: 'published', reason: 'admin' })
  assert.match(
    body.moderationNotice,
    /потому что вы администратор/i,
    'мгновенная публикация без объяснения неотличима от сломанной модерации',
  )

  const found = await app.inject({ method: 'GET', url: '/api/books?q=администратора' })
  assert.equal(found.json().total, 1)
})

test('модерация выключена: публикуется сразу, объяснять нечего', async () => {
  // env читается при вызове, а не при импорте — так режим переключается без
  // перезапуска процесса; MODERATION_ON снимают именно так же (правка .env + рестарт)
  env.moderation = false
  const res = await addBook('Книга без модерации', PERSON)
  const body = res.json()
  assert.equal(body.book.reviewStatus, 'approved')
  assert.deepEqual(body.moderation, { state: 'published', reason: 'moderation_off' })
  assert.equal(body.moderationNotice, null, 'обычный порядок не нуждается в пояснении')
})

test('счётчики полки: книга на проверке видна владельцу отдельным состоянием', async () => {
  await addBook('На проверке', PERSON)
  await addBook('Ещё одна на проверке', PERSON)

  const shelf = (await myShelf(PERSON)).json()
  assert.equal(shelf.books.length, 2)
  const states = shelf.books.map((b: { state: string }) => b.state).sort()
  assert.deepEqual(states, ['pending', 'pending'])

  // у админа на его же полке — «на полке», а не «на проверке»
  await addBook('Админская', ADMIN)
  const adminShelf = (await myShelf(ADMIN)).json()
  assert.deepEqual(
    adminShelf.books.map((b: { state: string }) => b.state),
    ['active'],
  )
})

test('текст исхода — один на бота и Mini App (своих формулировок нигде не пишем)', () => {
  assert.match(moderationNotice({ state: 'pending' })!, /на проверку модератору/i)
  assert.match(
    moderationNotice({ state: 'published', reason: 'admin' })!,
    /потому что вы администратор/i,
  )
  assert.equal(moderationNotice({ state: 'published', reason: 'moderation_off' }), null)
})
