/**
 * Дайджест новинок: что считается новинкой и почему одного `addedAt` мало.
 *
 * Поводом стал вопрос «почему за сутки ничего не показывает»: данные оказались
 * честными (за сутки книг правда не добавляли), но по дороге вскрылись два
 * случая, когда книга не попала бы в дайджест никогда — см. тесты ниже.
 * Запуск: npm run test -w server
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `digest-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'
process.env.BOT_TOKEN = '123456:test-token-for-signature'
process.env.NOTION_TOKEN_V2 = ''

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { digest, isFresh } = await import('./digest.js')

/** «Сейчас» в тестах фиксировано: дайджест не должен зависеть от часа прогона. */
const NOW = new Date('2026-07-29T12:00:00Z').getTime()
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000)

before(async () => {
  await prisma.book.deleteMany()
})

beforeEach(async () => {
  await prisma.book.deleteMany()
})

after(async () => {
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

/** Книга с явными датами: `addedAt` — из таблицы проекта, `createdAt` — наша. */
async function book(opts: {
  title: string
  addedAt: Date | null
  createdAt: Date
  city?: string
  reviewStatus?: string
}) {
  return prisma.book.create({
    data: {
      title: opts.title,
      kind: 'book',
      active: true,
      reviewStatus: opts.reviewStatus ?? 'approved',
      city: opts.city ?? 'Warszawa',
      addedAt: opts.addedAt,
      createdAt: opts.createdAt,
    },
  })
}

test('свежая книга попадает в суточный дайджест', async () => {
  await book({ title: 'Свежая', addedAt: hoursAgo(2), createdAt: hoursAgo(2) })
  const d = await digest('day', undefined, 20, NOW)
  assert.equal(d.total, 1)
  assert.deepEqual(d.items.map((i) => i.title), ['Свежая'])
})

test('старая книга в суточный дайджест не лезет', async () => {
  await book({ title: 'Старая', addedAt: hoursAgo(80), createdAt: hoursAgo(80) })
  assert.equal((await digest('day', undefined, 20, NOW)).total, 0)
  assert.equal((await digest('month', undefined, 20, NOW)).total, 1)
})

test('вчерашняя полночь: книгу вписали вчера вечером, а дата в таблице без времени', async () => {
  // в таблице проекта стоит ДАТА, поэтому у книги, добавленной вчера в 23:00,
  // `addedAt` = вчера 00:00 — она «старше суток» уже к утру. Но у нас она
  // появилась только что, и для человека это новинка
  await book({
    title: 'Вчерашняя полночь',
    addedAt: new Date('2026-07-28T00:00:00Z'),
    createdAt: hoursAgo(1),
  })
  const d = await digest('day', undefined, 20, NOW)
  assert.deepEqual(d.items.map((i) => i.title), ['Вчерашняя полночь'])
})

test('сверка раз в 12 часов: книга, вписанная позавчера, а увиденная сегодня', async () => {
  // раньше такая книга не попадала в суточный дайджест ВООБЩЕ: ни в день, когда
  // её вписали (мы о ней ещё не знали), ни в день, когда узнали (дата старая)
  await book({ title: 'Догнала синком', addedAt: hoursAgo(50), createdAt: hoursAgo(3) })
  const d = await digest('day', undefined, 20, NOW)
  assert.deepEqual(d.items.map((i) => i.title), ['Догнала синком'])
})

test('книга на модерации в новинки не попадает', async () => {
  await book({
    title: 'На проверке',
    addedAt: hoursAgo(1),
    createdAt: hoursAgo(1),
    reviewStatus: 'pending',
  })
  assert.equal((await digest('day', undefined, 20, NOW)).total, 0)
})

test('города считаются по тем же книгам, что и список', async () => {
  await book({ title: 'Первая', addedAt: hoursAgo(2), createdAt: hoursAgo(2), city: 'Warszawa' })
  await book({ title: 'Вторая', addedAt: hoursAgo(3), createdAt: hoursAgo(3), city: 'Kraków' })
  await book({ title: 'Третья', addedAt: hoursAgo(4), createdAt: hoursAgo(4), city: 'Warszawa' })
  const d = await digest('day', undefined, 20, NOW)
  assert.equal(d.total, 3)
  assert.deepEqual(d.byCity, [
    { city: 'Warszawa', count: 2 },
    { city: 'Kraków', count: 1 },
  ])
})

test('фильтр по городу сужает и список, и счётчик', async () => {
  await book({ title: 'Варшавская', addedAt: hoursAgo(2), createdAt: hoursAgo(2), city: 'Warszawa' })
  await book({ title: 'Краковская', addedAt: hoursAgo(2), createdAt: hoursAgo(2), city: 'Kraków' })
  const d = await digest('day', 'Kraków', 20, NOW)
  assert.equal(d.total, 1)
  assert.deepEqual(d.items.map((i) => i.title), ['Краковская'])
})

test('первое наполнение базы не превращает весь каталог в новинки', async () => {
  // регрессия, пойманная прод-смоуком 29 июля: база на сервере создана 22 июля,
  // поэтому `createdAt` у всех 3249 книг попал в месячное окно, и «новинки за
  // месяц» показали весь каталог вместо восьмидесяти книг
  for (let i = 0; i < 5; i++) {
    await book({
      title: `Старая из каталога ${i}`,
      addedAt: hoursAgo(24 * 200), // вписана в таблицу давным-давно
      createdAt: hoursAgo(3), // а у нас появилась при первом наполнении базы
    })
  }
  await book({ title: 'Правда свежая', addedAt: hoursAgo(4), createdAt: hoursAgo(3) })

  const month = await digest('month', undefined, 20, NOW)
  assert.deepEqual(month.items.map((i) => i.title), ['Правда свежая'])
  assert.equal(month.total, 1)
})

test('книга без даты в таблице проекта считается по нашей', async () => {
  await book({ title: 'Без даты', addedAt: null, createdAt: hoursAgo(5) })
  assert.equal((await digest('day', undefined, 20, NOW)).total, 1)
})

/* ── значок «Новинка» на обложке ────────────────────────── */

test('значок «Новинка»: свежая книга да, старая нет', () => {
  const since = new Date(NOW - 7 * 24 * 3600_000)
  assert.equal(isFresh({ addedAt: hoursAgo(20), createdAt: hoursAgo(20) }, since), true)
  assert.equal(isFresh({ addedAt: hoursAgo(24 * 30), createdAt: hoursAgo(24 * 30) }, since), false)
})

test('значок «Новинка» не вешается на весь каталог, залитый в базу разом', () => {
  // то же правило, что у подборки новинок: если бы значок смотрел только на
  // «когда появилось у нас», после переналивки базы новинками стали бы все 3249
  const since = new Date(NOW - 7 * 24 * 3600_000)
  assert.equal(isFresh({ addedAt: hoursAgo(24 * 200), createdAt: hoursAgo(2) }, since), false)
  // а книга, вписанная на днях и подхваченная сверкой сегодня, — новинка
  assert.equal(isFresh({ addedAt: hoursAgo(24 * 8), createdAt: hoursAgo(2) }, since), true)
})

test('книга без даты в таблице проекта судится по нашей и здесь тоже', () => {
  const since = new Date(NOW - 7 * 24 * 3600_000)
  assert.equal(isFresh({ addedAt: null, createdAt: hoursAgo(3) }, since), true)
  assert.equal(isFresh({ addedAt: null, createdAt: hoursAgo(24 * 20) }, since), false)
})
