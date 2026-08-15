/**
 * Поиск по каталогу: релевантность и устойчивость страниц (аудит 14.08.2026).
 *
 * Найдено: релевантность сравнивала ТОЛЬКО фразу целиком, поэтому обычный
 * человеческий запрос с переставленными словами давал ноль всем книгам сразу и
 * выдача молча падала в сортировку по дате. А при равном счёте порядок задавал
 * движок базы — на границе страниц одна книга могла показаться дважды, другая
 * не показаться вовсе.
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

const DB_FILE = join(tmpdir(), `search-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma, buildSearch } = await import('./db.js')
const { searchBooks } = await import('./search.js')

async function addBook(title: string, author: string | null = null) {
  const data = {
    title,
    author,
    kind: 'book',
    active: true,
    reviewStatus: 'approved',
    genres: '',
    languages: '',
    city: 'Warszawa',
  }
  return prisma.book.create({ data: { ...data, search: buildSearch(data) } })
}

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

test('при перестановке слов выше та книга, где нашлись оба слова в названии', async () => {
  // Отбор строк в базе и так идёт ПО СЛОВАМ — ломалась именно сортировка:
  // фраза «маргарита мастер» целиком не встречается нигде, и все совпадения
  // получали ноль, то есть выдача молча становилась «по дате добавления».
  await addBook('Мастер и Маргарита', 'Михаил Булгаков')
  // добавлена позже, поэтому при нулевой релевантности была бы первой
  await addBook('Мастер', 'Маргарита Иванова')

  const r = await searchBooks({ q: 'маргарита мастер' })
  assert.deepEqual(
    r.items.map((b) => b.title),
    ['Мастер и Маргарита', 'Мастер'],
  )
})

test('точное совпадение по-прежнему впереди', async () => {
  await addBook('Дюна', 'Фрэнк Герберт')
  await addBook('Дюна: Мессия', 'Фрэнк Герберт')
  const r = await searchBooks({ q: 'дюна' })
  assert.equal(r.items[0].title, 'Дюна')
})

test('фамилия автора работает как слово запроса', async () => {
  await addBook('Солярис', 'Станислав Лем')
  await addBook('Лем: биография', 'Другой автор')
  const r = await searchBooks({ q: 'лем солярис' })
  assert.equal(r.items[0].title, 'Солярис', 'книга, где нашлись оба слова, должна быть первой')
})

test('при равной релевантности порядок задан явно, а не движком базы', async () => {
  // одинаковые по счёту книги раньше приходили в порядке, который выбирала база;
  // на границе страниц это давало дубль на одной странице и пропажу на другой
  const ids: string[] = []
  for (let i = 0; i < 6; i++) ids.push((await addBook(`Сборник рассказов ${i}`, 'Разные авторы')).id)

  const page = await searchBooks({ q: 'сборник', limit: 6 })
  assert.deepEqual(
    page.items.map((b) => b.id),
    [...ids].sort(),
    'равные по релевантности идут по возрастанию id — детерминированно',
  )
})
