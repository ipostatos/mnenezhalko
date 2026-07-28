/**
 * Приватность контактов (этап 9.2) на РЕАЛЬНОМ Fastify через app.inject:
 * каталог остаётся публичным, а ники/инстаграм отдаются только запросу с
 * валидной подписью Telegram. Числовые tgId не уходят клиенту вообще.
 *
 * Ключевой тест здесь — не «поле скрыто у книги», а сплошное сканирование
 * ответов ВСЕХ публичных ручек: новая ручка, забывшая про redact, свалит тест.
 * Своя временная SQLite, никакой сети. Запуск: npm run test -w server
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import crypto, { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import Fastify from 'fastify'

const DB_FILE = join(tmpdir(), `privacy-test-${randomUUID()}.db`)
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

const CITY = 'Radom' // реальный город из CITIES: произвольный теперь отклоняется валидацией
const HANDLE = 'lizaveta_test'
const INSTA = 'lizaveta_insta'
const VISITOR_TG = 555000111n
const AUTHOR_TG = 555000222n
const AUTHOR_HANDLE = 'market_author'

let librarianId = ''
let bookId = ''

/** Настоящая подпись Telegram тем же алгоритмом, что проверяет auth.ts. */
function signInitData(user: { id: string; username?: string }): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify(user),
  })
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n')
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN!).digest()
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex')
  params.set('hash', hash)
  return params.toString()
}

const SIGNED = { 'x-init-data': signInitData({ id: String(VISITOR_TG), username: 'visitor' }) }

before(async () => {
  const librarian = await prisma.librarian.create({
    data: { name: 'Лизавета', telegram: HANDLE, instagram: INSTA, city: CITY, notionId: randomUUID() },
  })
  librarianId = librarian.id
  const book = await prisma.book.create({
    data: {
      title: 'Тестовая книга про приватность',
      city: CITY,
      active: true,
      reviewStatus: 'approved',
      ownerId: librarian.id,
      addedAt: new Date(),
    },
  })
  bookId = book.id

  // объявление барахолки: у автора и числовой id, и ник
  await prisma.user.create({ data: { tgId: AUTHOR_TG, username: AUTHOR_HANDLE } })
  await prisma.marketItem.create({
    data: {
      city: CITY,
      title: 'Отдам книги даром',
      status: 'active',
      authorTg: AUTHOR_TG,
      authorUsername: AUTHOR_HANDLE,
    },
  })

  // встреча, созданная админом (createdBy = его tgId)
  await prisma.event.create({
    data: {
      city: CITY,
      title: 'Книжная встреча',
      startsAt: new Date(Date.now() + 3600_000),
      createdBy: AUTHOR_TG,
    },
  })
})

after(async () => {
  await prisma.$disconnect()
  unlinkSync(DB_FILE)
})

async function buildApp() {
  const app = Fastify()
  await registerRoutes(app)
  return app
}

/** Все публичные (без подписи) ручки, отдающие данные. */
const PUBLIC_ROUTES = () => [
  '/api/health',
  `/api/facets?city=${encodeURIComponent(CITY)}`,
  `/api/books?city=${encodeURIComponent(CITY)}`,
  `/api/books/${bookId}`,
  `/api/librarians/${librarianId}`,
  `/api/showcase?city=${encodeURIComponent(CITY)}`,
  '/api/digest?period=month',
  '/api/cities',
  `/api/groups?city=${encodeURIComponent(CITY)}`,
  `/api/events?city=${encodeURIComponent(CITY)}`,
  `/api/market?city=${encodeURIComponent(CITY)}`,
]

test('без подписи: контакт библиотекаря не отдаётся ни в списке, ни в карточке', async () => {
  const app = await buildApp()
  const list = (await app.inject({ method: 'GET', url: `/api/books?city=${encodeURIComponent(CITY)}` })).json() as any
  assert.ok(list.items.length > 0, 'книга должна находиться — каталог остаётся публичным')
  assert.equal(list.items[0].owner.telegram, null)
  assert.equal(list.items[0].owner.instagram, null)
  assert.equal(list.items[0].owner.name, 'Лизавета', 'имя владельца публично (оно и в открытом Notion)')

  const card = (await app.inject({ method: 'GET', url: `/api/books/${bookId}` })).json() as any
  assert.equal(card.owner.telegram, null)
})

test('с подписью Telegram: контакт отдаётся — Mini App продолжает работать', async () => {
  const app = await buildApp()
  const list = (
    await app.inject({ method: 'GET', url: `/api/books?city=${encodeURIComponent(CITY)}`, headers: SIGNED })
  ).json() as any
  assert.equal(list.items[0].owner.telegram, HANDLE)
  assert.equal(list.items[0].owner.instagram, INSTA)

  const shelf = (await app.inject({ method: 'GET', url: `/api/librarians/${librarianId}`, headers: SIGNED })).json() as any
  assert.equal(shelf.owner.telegram, HANDLE, 'экран полки библиотекаря должен показывать «Написать»')
  assert.equal(shelf.books[0].owner?.telegram ?? HANDLE, HANDLE)
})

test('подделанная подпись не даёт контактов', async () => {
  const app = await buildApp()
  const forged = signInitData({ id: String(VISITOR_TG) }).replace(/hash=[0-9a-f]+/, 'hash=' + 'a'.repeat(64))
  const res = (
    await app.inject({
      method: 'GET',
      url: `/api/books?city=${encodeURIComponent(CITY)}`,
      headers: { 'x-init-data': forged },
    })
  ).json() as any
  assert.equal(res.items[0].owner.telegram, null, 'битый hash = анонимный запрос')
})

test('полка библиотекаря без подписи: книги видны, контакт скрыт', async () => {
  const app = await buildApp()
  const res = (await app.inject({ method: 'GET', url: `/api/librarians/${librarianId}` })).json() as any
  assert.ok(res.books.length > 0)
  assert.equal(res.owner.telegram, null)
  assert.equal(res.owner.instagram, null)
})

test('дайджест новинок без подписи не раздаёт контакты', async () => {
  const app = await buildApp()
  const res = (await app.inject({ method: 'GET', url: '/api/digest?period=month' })).json() as any
  assert.ok(res.items.length > 0, 'книга добавлена с addedAt — должна попасть в дайджест месяца')
  assert.equal(res.items[0].owner.telegram, null)
})

test('барахолка: числовой tgId автора не уходит клиенту НИКОГДА, ник — только по подписи', async () => {
  const app = await buildApp()
  const anon = (await app.inject({ method: 'GET', url: `/api/market?city=${encodeURIComponent(CITY)}` })).json() as any[]
  assert.equal(anon.length, 1)
  assert.equal(anon[0].authorUsername, null, 'ник автора объявления — контакт')
  assert.ok(!('authorTg' in anon[0]), 'числовой id не должен появляться в ответе вовсе')

  const signed = (
    await app.inject({ method: 'GET', url: `/api/market?city=${encodeURIComponent(CITY)}`, headers: SIGNED })
  ).json() as any[]
  assert.equal(signed[0].authorUsername, AUTHOR_HANDLE, 'кнопка «Написать» в Mini App должна работать')
  assert.ok(!('authorTg' in signed[0]), 'даже подписанному числовой id не нужен')
})

test('встречи: createdBy (tgId админа) не отдаётся даже подписанному', async () => {
  const app = await buildApp()
  for (const headers of [undefined, SIGNED]) {
    const res = (await app.inject({ method: 'GET', url: `/api/events?city=${encodeURIComponent(CITY)}`, headers })).json() as any[]
    assert.equal(res.length, 1)
    assert.ok(!('createdBy' in res[0]))
  }
})

/**
 * Сплошная проверка: пройти по всем публичным ручкам и убедиться, что нигде в
 * ответе нет ни ника, ни инстаграма, ни числового tgId. Именно этот тест
 * поймает НОВУЮ ручку, автор которой забыл про redact.
 */
test('ни одна публичная ручка не отдаёт контакты анонимному запросу', async () => {
  const app = await buildApp()
  const secrets = [HANDLE, INSTA, AUTHOR_HANDLE, String(AUTHOR_TG)]
  for (const url of PUBLIC_ROUTES()) {
    const res = await app.inject({ method: 'GET', url })
    assert.equal(res.statusCode, 200, `${url} должен отвечать 200`)
    const body = res.body
    for (const secret of secrets) {
      assert.ok(
        !body.includes(secret),
        `${url} отдал «${secret}» анонимному запросу — пропущен redact (см. privacy.ts)`,
      )
    }
  }
})

test('подписанному запросу те же ручки отдают контакты (ничего не сломали ради приватности)', async () => {
  const app = await buildApp()
  const withContacts = [
    `/api/books?city=${encodeURIComponent(CITY)}`,
    `/api/books/${bookId}`,
    `/api/librarians/${librarianId}`,
    '/api/digest?period=month',
    `/api/market?city=${encodeURIComponent(CITY)}`,
  ]
  const seen: string[] = []
  for (const url of withContacts) {
    const res = await app.inject({ method: 'GET', url, headers: SIGNED })
    assert.equal(res.statusCode, 200)
    seen.push(res.body)
  }
  assert.ok(seen.filter((b) => b.includes(HANDLE)).length >= 4, 'ник библиотекаря должен быть виден в Mini App')
  assert.ok(seen.some((b) => b.includes(AUTHOR_HANDLE)), 'ник автора объявления должен быть виден в Mini App')
})
