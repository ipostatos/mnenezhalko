/**
 * Права проверяются у САМОГО ДЕЙСТВИЯ, а не у двери (аудит 14.08.2026).
 *
 * Найденное: у добавления книги шесть входов (одиночный ISBN, /import, список
 * ISBN без команды, фото, кнопка пачки, кнопка черновика), а проверка
 * ограничений стояла у четырёх. Ограниченный человек добавлял книги, послав
 * несколько строк ISBN подряд. У барахолки проверки не было вовсе.
 *
 * Поэтому проверка переехала внутрь `putOnShelf`/`saveOffer`: сколько бы дверей
 * ни появилось потом, мимо неё пройти нельзя. Тесты здесь ходят прямо в эти
 * функции — то есть проверяют именно замок, а не то, что кнопку спрятали.
 *
 * Запуск: npm run test -w server
 */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `rights-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { putOnShelf } = await import('./publish.js')
const { saveOffer } = await import('./market.js')
const { NotAllowedError } = await import('./moderation.js')

const READER = 5001n
const draft = (title: string) => ({
  tgId: READER,
  username: 'reader',
  firstName: 'Читатель',
  kind: 'book' as const,
  title,
  author: 'Автор',
  city: 'Warszawa',
})

const offer = {
  kind: 'give' as const,
  title: 'Отдам шкаф',
  description: null,
  price: null,
  city: 'Warszawa',
  district: null,
  locality: null,
}

const restrict = (scope: string, tgId = READER) =>
  prisma.userRestriction.create({
    data: { userTg: tgId, scope, reason: 'проверка', createdByTg: 1n },
  })

const ban = (tgId = READER) =>
  prisma.user.update({
    where: { tgId },
    data: { accountStatus: 'banned', banReason: 'реклама', bannedAt: new Date() },
  })

beforeEach(async () => {
  await prisma.marketItem.deleteMany()
  await prisma.book.deleteMany()
  await prisma.librarian.deleteMany()
  await prisma.userRestriction.deleteMany()
  await prisma.user.deleteMany()
  await prisma.user.create({ data: { tgId: READER, username: 'reader', firstName: 'Читатель' } })
})

after(async () => {
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

/* ── книги ───────────────────────────────────────────────── */

test('без ограничений книга встаёт на полку', async () => {
  const res = await putOnShelf(draft('Дюна'))
  assert.equal(res.book.title, 'Дюна')
  assert.equal(await prisma.book.count(), 1)
})

test('ограничение add_books останавливает добавление В САМОЙ функции, а не у двери', async () => {
  await restrict('add_books')
  await assert.rejects(
    () => putOnShelf(draft('Дюна')),
    (e: unknown) => e instanceof NotAllowedError && e.verdict.code === 'restricted',
  )
  assert.equal(await prisma.book.count(), 0, 'книга не должна появиться ни в каком виде')
})

test('ограничение «все действия» тоже закрывает добавление', async () => {
  await restrict('all')
  await assert.rejects(() => putOnShelf(draft('Дюна')), NotAllowedError)
  assert.equal(await prisma.book.count(), 0)
})

test('забаненный не добавляет книги', async () => {
  await ban()
  await assert.rejects(
    () => putOnShelf(draft('Дюна')),
    (e: unknown) => e instanceof NotAllowedError && e.verdict.code === 'banned',
  )
  assert.equal(await prisma.book.count(), 0)
})

test('снятое ограничение больше не мешает', async () => {
  const r = await restrict('add_books')
  await prisma.userRestriction.update({ where: { id: r.id }, data: { liftedAt: new Date() } })
  const res = await putOnShelf(draft('Солярис'))
  assert.equal(res.book.title, 'Солярис')
})

test('истёкшее ограничение больше не мешает', async () => {
  await prisma.userRestriction.create({
    data: {
      userTg: READER,
      scope: 'add_books',
      reason: 'проверка',
      createdByTg: 1n,
      expiresAt: new Date(Date.now() - 60_000),
    },
  })
  const res = await putOnShelf(draft('Пикник на обочине'))
  assert.equal(res.book.title, 'Пикник на обочине')
})

test('ограничение на отзывы не мешает добавлять книги', async () => {
  await restrict('reviews')
  const res = await putOnShelf(draft('Дюна'))
  assert.equal(res.book.title, 'Дюна')
})

/* ── барахолка ───────────────────────────────────────────── */

const msg = (id: number) => ({ id, authorTg: READER, authorUsername: 'reader', firstName: 'Читатель' })

test('без ограничений карточка барахолки создаётся', async () => {
  const saved = await saveOffer(offer, msg(1))
  assert.ok(saved, 'карточка должна появиться')
  assert.equal(await prisma.marketItem.count(), 1)
})

test('ограничение market: пост не превращается в карточку витрины', async () => {
  await restrict('market')
  const saved = await saveOffer(offer, msg(2))
  assert.equal(saved, null)
  assert.equal(await prisma.marketItem.count(), 0)
})

test('забаненный не публикует барахолку', async () => {
  await ban()
  const saved = await saveOffer(offer, msg(3))
  assert.equal(saved, null)
  assert.equal(await prisma.marketItem.count(), 0)
})
