/**
 * Проверка канала записи в Notion: кто мы, видим ли схемы таблиц и как
 * ложатся поля. Создаёт тестовые строки в Owners и All Books, читает их
 * обратно и архивирует — в таблицах проекта ничего не остаётся.
 *
 *   npm run notion:check -w server
 */
import { env } from './env.js'
import {
  archiveRow,
  createBook,
  createOwner,
  loadBlock,
  notionWriteEnabled,
  whoAmI,
} from './notion-write.js'
import { collectionSchema } from './notion.js'

if (!notionWriteEnabled()) {
  console.error('Нет NOTION_TOKEN_V2 — запись выключена.')
  process.exit(1)
}

const me = await whoAmI()
console.log('аккаунт Notion:', me ? `${me.email ?? '—'} (${me.id})` : 'не определился')

const [books, owners] = await Promise.all([
  collectionSchema(env.notion.books.collection, env.notion.books.view),
  collectionSchema(env.notion.librarians.collection, env.notion.librarians.view),
])

const stamp = new Date().toISOString().slice(0, 16)

console.log('\n1) завожу тестового библиотекаря в Owners…')
const ownerId = await createOwner({
  name: `[проверка бота ${stamp}]`,
  telegram: 'mnenezhalkobot',
  cityDistrict: 'Warszawa/Wola',
})
console.log('   страница:', ownerId)

console.log('2) добавляю тестовую книгу в All Books…')
const bookId = await createBook({
  kind: 'book',
  title: `[проверка бота ${stamp}]`,
  author: 'Тестовый Автор',
  genres: ['Фантастика'],
  languages: ['Русский'],
  coverUrl: 'https://mnenezhalko-46-224-220-94.sslip.io/api/cover/test.jpg',
  ownerNotionId: ownerId,
})
console.log('   страница:', bookId)

console.log('3) читаю обратно, что записалось:')
const row = await loadBlock(bookId)
const show = (schema: Record<string, string>, props: any, name: string) =>
  console.log(`   ${name}: ${JSON.stringify(props?.[schema[name]] ?? null)}`)
for (const name of ['Title', 'Author', 'Genre', 'Language', 'Cover', 'Owner (click on the name)', 'Date added']) {
  show(books.byName, row?.properties, name)
}

const ownerRow = await loadBlock(ownerId)
console.log('   обратная связь у владельца:', JSON.stringify(ownerRow?.properties?.[owners.byName['🎃 All Books']] ?? null))
console.log('   City/District владельца:', JSON.stringify(ownerRow?.properties?.[owners.byName['City/District']] ?? null))

console.log('\n4) убираю тестовые строки…')
await archiveRow(bookId)
await archiveRow(ownerId)
console.log('готово — в таблицах проекта пусто')
