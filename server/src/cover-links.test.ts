/**
 * Регрессия 27 июля: в «Библиотеке» пропали обложки.
 *
 * Причина: `toCard(b, w?: number)` получил вторым параметром ширину превью, а
 * все существующие `rows.map(toCard)` начали передавать туда ИНДЕКС массива
 * (второй аргумент колбэка `map`). Ссылки уезжали с `w=0,1,2…`, обработчик
 * `/api/img` подгонял ширину под свои границы, подпись переставала сходиться —
 * и каждая обложка отвечала 400.
 *
 * Тест сплошной: проходит по ВСЕМ ручкам, отдающим обложки, и проверяет, что
 * ширина в ссылке — из белого списка. Новая ручка со своим `map(toCard)`
 * свалит его. Запуск: npm run test -w server
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import crypto, { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import Fastify from 'fastify'

const DB_FILE = join(tmpdir(), `cover-links-test-${randomUUID()}.db`)
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
const { ALLOWED_WIDTHS, LIST_W, CARD_W, CAROUSEL_W, proxyCover } = await import('./imgcache.js')
const { searchBooks, toCard } = await import('./search.js')
const { buildSearch } = await import('./db.js')

const COVER = 'https://s1.livelib.ru/boocover/1/o/abcd/cover.jpeg'
const CITY = 'Warszawa'
let librarianId = ''

function signInitData(user: { id: string; username?: string }): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify(user),
  })
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n')
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN!).digest()
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'))
  return params.toString()
}

const SIGNED = { 'x-init-data': signInitData({ id: '900000111', username: 'reader' }) }
const app = Fastify()

before(async () => {
  const lib = await prisma.librarian.create({ data: { name: 'Библиотекарь', city: CITY } })
  librarianId = lib.id
  // несколько книг: индекс массива должен был бы стать шириной у 2-й, 3-й…
  for (let i = 0; i < 5; i++) {
    const title = `Книга ${i}`
    await prisma.book.create({
      data: {
        title,
        author: 'Автор',
        city: CITY,
        coverUrl: `${COVER}?n=${i}`,
        ownerId: lib.id,
        source: 'bot',
        addedAt: new Date(),
        search: buildSearch({ title, author: 'Автор', city: CITY }),
      },
    })
  }
  await registerRoutes(app)
  await app.ready()
})

/** Все ширины в ответе — из белого списка (`w=0`/`w=2` поймает именно это). */
function assertWidths(payload: unknown, where: string) {
  const found = [...JSON.stringify(payload).matchAll(/\\?u=[^"]*?&w=(\d+)/g)].map((m) => Number(m[1]))
  assert.ok(found.length > 0, `${where}: в ответе нет ни одной ссылки на обложку`)
  for (const w of found) {
    assert.ok(
      ALLOWED_WIDTHS.includes(w),
      `${where}: ширина ${w} вне белого списка ${ALLOWED_WIDTHS.join('/')}`,
    )
  }
}

test('каталог книг отдаёт обложки с допустимой шириной (сломалось именно здесь)', async () => {
  const r = await app.inject({ method: 'GET', url: `/api/books?city=${encodeURIComponent(CITY)}` })
  assert.equal(r.statusCode, 200)
  assertWidths(r.json(), 'GET /api/books')
})

test('дайджест новинок отдаёт обложки с допустимой шириной', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/digest?period=month' })
  assert.equal(r.statusCode, 200)
  assertWidths(r.json(), 'GET /api/digest')
})

test('полка библиотекаря отдаёт обложки с допустимой шириной', async () => {
  const r = await app.inject({ method: 'GET', url: `/api/librarians/${librarianId}` })
  assert.equal(r.statusCode, 200)
  assertWidths(r.json(), 'GET /api/librarians/:id')
})

test('витрина карусели отдаёт обложки с допустимой шириной', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/showcase' })
  assert.equal(r.statusCode, 200)
  assertWidths(r.json(), 'GET /api/showcase')
})

test('поиск по запросу отдаёт обложки с допустимой шириной', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/books?q=Книга' })
  assert.equal(r.statusCode, 200)
  assertWidths(r.json(), 'GET /api/books?q=')
})

test('searchBooks через map(toCard) не подставляет индекс в ширину', async () => {
  const { items } = await searchBooks({ city: CITY })
  const widths = items
    .map((b) => b.coverUrl)
    .filter((u): u is string => Boolean(u))
    .map((u) => Number(new URLSearchParams(u.split('?')[1]).get('w')))
  assert.equal(widths.length, 5)
  for (const w of widths) assert.ok(ALLOWED_WIDTHS.includes(w), `ширина ${w} вне белого списка`)
})

test('ссылка с чужой шириной не создаётся: подпись и ширина обязаны совпадать', () => {
  const link = proxyCover(COVER, 7 as number)!
  const w = Number(new URLSearchParams(link.split('?')[1]).get('w'))
  assert.equal(w, LIST_W, 'посторонняя ширина должна схлопнуться в размер по умолчанию')
})

test('обработчик /api/img отвергает ширину вне белого списка', async () => {
  const link = proxyCover(COVER, CAROUSEL_W)!
  const broken = link.replace(`w=${CAROUSEL_W}`, 'w=7')
  const r = await app.inject({ method: 'GET', url: broken })
  assert.equal(r.statusCode, 400)
  assert.equal(r.json().error, 'bad_width')
})

test('карточка книги целиком берёт размер разворота, а не списка', async () => {
  const b = await prisma.book.findFirst({ where: { city: CITY } })
  const r = await app.inject({ method: 'GET', url: `/api/books/${b!.id}`, headers: SIGNED })
  assert.equal(r.statusCode, 200)
  const w = Number(new URLSearchParams(r.json().coverUrl.split('?')[1]).get('w'))
  assert.equal(w, CARD_W)
})

test('toCard без ширины даёт размер списков', () => {
  const card = toCard({ id: 'x', title: 'T', coverUrl: COVER, kind: 'book' })
  const w = Number(new URLSearchParams(card.coverUrl!.split('?')[1]).get('w'))
  assert.equal(w, LIST_W)
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})
