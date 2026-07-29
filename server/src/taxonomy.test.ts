/**
 * Справочник жанров и языков: значения берутся из Notion, приложение только
 * выбирает из готового списка.
 *
 * Проверяем ровно то, ради чего это сделано: своё значение завести нельзя
 * (иначе оно уедет в общую таблицу и навсегда добавит там вариант), а то, что
 * уже стоит у книги с 2023 года, правкой не стирается.
 * Запуск: npm run test -w server
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import Fastify from 'fastify'

const DB_FILE = join(tmpdir(), `taxonomy-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'
process.env.BOT_TOKEN = '123456:test-token-for-signature'
process.env.NOTION_TOKEN_V2 = ''

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { registerRoutes } = await import('./routes.js')
const {
  FALLBACK_GENRES,
  FALLBACK_LANGUAGES,
  MAX_GENRES,
  TAXONOMY_KEY,
  getTaxonomy,
  resetTaxonomyCache,
  sanitizeAgainst,
  sanitizeGenres,
  sanitizeLanguages,
  taxonomyFromSchema,
} = await import('./taxonomy.js')
const { editBook, putOnShelf } = await import('./publish.js')

const OWNER = 940001n
const app = Fastify()

before(async () => {
  await registerRoutes(app)
  await app.ready()
})

beforeEach(async () => {
  await prisma.book.deleteMany()
  await prisma.librarian.deleteMany()
  await prisma.user.deleteMany()
  await prisma.syncState.deleteMany()
  resetTaxonomyCache()
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

test('справочник читается из схемы коллекции Notion', () => {
  const t = taxonomyFromSchema({
    byName: {},
    typeById: {},
    optionsByName: { Genre: ['Фентези', 'Детектив'], Language: ['Polski'] },
  })
  assert.deepEqual(t.genres, ['Фентези', 'Детектив'])
  assert.deepEqual(t.languages, ['Polski'])
})

test('пустое свойство в схеме не обнуляет справочник — остаёмся на снимке', () => {
  const t = taxonomyFromSchema({ byName: {}, typeById: {}, optionsByName: { Genre: [] } })
  assert.equal(t.genres, FALLBACK_GENRES)
  assert.equal(t.languages, FALLBACK_LANGUAGES)
})

test('сохранённый справочник переживает рестарт (SyncState), в Notion не ходим', async () => {
  await prisma.syncState.create({
    data: { key: TAXONOMY_KEY, value: JSON.stringify({ genres: ['Хайку'], languages: ['Suomi'] }) },
  })
  const t = await getTaxonomy()
  assert.deepEqual(t.genres, ['Хайку'])
  assert.deepEqual(t.languages, ['Suomi'])
})

test('битая запись справочника не роняет ручки — работаем по снимку', async () => {
  await prisma.syncState.create({ data: { key: TAXONOMY_KEY, value: 'не json' } })
  const t = await getTaxonomy()
  assert.equal(t.genres, FALLBACK_GENRES)
})

test('чужое значение отбрасывается, своё пишется каноническим написанием', () => {
  const allowed = ['Фентези', 'Детская литература']
  assert.deepEqual(sanitizeAgainst(['фентези '], allowed), ['Фентези'])
  assert.deepEqual(sanitizeAgainst(['Художка'], allowed), [])
  // дубли схлопываются: «Фентези» и «фентези» это один и тот же вариант
  assert.deepEqual(sanitizeAgainst(['Фентези', 'фентези'], allowed), ['Фентези'])
})

test('то, что уже стоит у книги, правкой не стирается', () => {
  const allowed = ['Фентези']
  assert.deepEqual(sanitizeAgainst(['Художка', 'Фентези'], allowed, ['Художка']), [
    'Художка',
    'Фентези',
  ])
})

test('число жанров ограничено', async () => {
  const many = FALLBACK_GENRES.slice(0, MAX_GENRES + 3)
  assert.equal((await sanitizeGenres(many)).length, MAX_GENRES)
})

test('язык из справочника проходит, выдуманный — нет', async () => {
  assert.deepEqual(await sanitizeLanguages(['Polski', 'Эльфийский']), ['Polski'])
})

test('/api/facets отдаёт справочник для форм', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/facets' })
  assert.equal(r.statusCode, 200)
  const body = r.json()
  assert.ok(body.genreOptions.includes('Фентези'))
  assert.ok(body.languageOptions.includes('Polski'))
  // справочник ≠ фактические значения каталога: пустая база, а список полон
  assert.equal(body.total, 0)
})

test('добавление книги: выдуманный жанр не попадает на полку', async () => {
  const res = await putOnShelf({
    tgId: OWNER,
    username: 'owner',
    firstName: 'Владелец',
    kind: 'book',
    title: 'Тестовая книга',
    author: 'Автор',
    genres: ['Фентези', 'Мой особенный жанр'],
    languages: ['Русский', 'Клингонский'],
    city: 'Warszawa',
  })
  assert.deepEqual(res.book.genres, ['Фентези'])
  assert.deepEqual(res.book.languages, ['Русский'])
})

test('правка книги: чужое отбрасывается, старое значение книги сохраняется', async () => {
  const res = await putOnShelf({
    tgId: OWNER,
    username: 'owner',
    firstName: 'Владелец',
    kind: 'book',
    title: 'Старая книга',
    genres: ['Фентези'],
    languages: ['Русский'],
    city: 'Warszawa',
  })
  // имитируем наследство синка: у книги стоит жанр, которого нет в справочнике
  await prisma.book.update({ where: { id: res.book.id }, data: { genres: 'Художка, Фентези' } })

  const edited = await editBook(res.book.id, OWNER, {
    genres: ['Художка', 'Детектив', 'Выдуманный жанр'],
  })
  assert.ok('card' in edited)
  assert.deepEqual(edited.card.genres, ['Художка', 'Детектив'])
})
