/**
 * P2.1 аудита 2026-07-28: публичные ручки не падают 500-й на мусорных
 * параметрах, а произвольный ?city= не раздувает кэш и SyncState.
 * Запуск: npm run test -w server
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import crypto, { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import Fastify from 'fastify'

const DB_FILE = join(tmpdir(), `api-val-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'
process.env.BOT_TOKEN = '123456:test-token-for-signature'
process.env.NOTION_TOKEN_V2 = ''
process.env.ADMIN_IDS = '555001' // upsertUser пересчитывает isAdmin из окружения
const ADMIN_TG = 555001n

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { registerRoutes } = await import('./routes.js')

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

const app = Fastify()

before(async () => {
  await registerRoutes(app)
  await app.ready()
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

test('GET /api/books?limit=abc — 200 с дефолтным лимитом, а не 500 (NaN в take)', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/books?limit=abc&offset=мусор' })
  assert.equal(r.statusCode, 200)
})

test('GET /api/books: отрицательные и гигантские limit/offset зажимаются', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/books?limit=-5&offset=-100' })
  assert.equal(r.statusCode, 200)
  const r2 = await app.inject({ method: 'GET', url: '/api/books?limit=99999' })
  assert.equal(r2.statusCode, 200)
})

test('произвольный ?city= в showcase — 400, SyncState не растёт', async () => {
  const junk = `Нью-Васюки-${randomUUID()}`
  const r = await app.inject({ method: 'GET', url: `/api/showcase?city=${encodeURIComponent(junk)}` })
  assert.equal(r.statusCode, 400)
  const rows = await prisma.syncState.count({ where: { key: { contains: junk } } })
  assert.equal(rows, 0, 'мусорный город не должен оставить строку кэша')
})

test('известный город в showcase работает', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/showcase?city=Warszawa' })
  assert.equal(r.statusCode, 200)
})

test('произвольный ?city= в facets — 400 (кэш по городу)', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/facets?city=abrakadabra' })
  assert.equal(r.statusCode, 400)
})

test('POST /api/events с кривой датой — 400, а не 500', async () => {
  await prisma.user.upsert({
    where: { tgId: 555001n },
    create: { tgId: 555001n, isAdmin: true },
    update: { isAdmin: true },
  })
  const headers = { 'x-init-data': signInitData({ id: '555001' }) }
  const r = await app.inject({
    method: 'POST',
    url: '/api/events',
    headers,
    payload: { city: 'Warszawa', title: 'Встреча', startsAt: 'не дата' },
  })
  assert.equal(r.statusCode, 400)
  const r2 = await app.inject({
    method: 'POST',
    url: '/api/events',
    headers,
    payload: { city: 'Город-которого-нет', title: 'Встреча', startsAt: '2026-08-01T18:00:00Z' },
  })
  assert.equal(r2.statusCode, 400)
})

test('POST /api/books: мусорный coverUrl (не URL) — 400, в базу не попадает', async () => {
  const headers = { 'x-init-data': signInitData({ id: '555002', username: 'lib_user' }) }
  const r = await app.inject({
    method: 'POST',
    url: '/api/books',
    headers,
    payload: { title: 'Книга с мусорной обложкой', coverUrl: 'javascript:alert(1)' },
  })
  assert.equal(r.statusCode, 400)
  const stored = await prisma.book.count({ where: { title: 'Книга с мусорной обложкой' } })
  assert.equal(stored, 0)
})

test('возврат чужой выдачи — 403, несуществующей — 404 (раньше оба были 404)', async () => {
  await prisma.user.upsert({ where: { tgId: 555003n }, create: { tgId: 555003n }, update: {} })
  await prisma.user.upsert({ where: { tgId: 555004n }, create: { tgId: 555004n }, update: {} })
  const loan = await prisma.loan.create({
    data: { title: 'Чужая книга', ownerTg: 555003n, holderUsername: 'someone', status: 'active' },
  })
  const stranger = { 'x-init-data': signInitData({ id: '555004' }) }
  const r = await app.inject({ method: 'POST', url: `/api/loans/${loan.id}/return`, headers: stranger, payload: {} })
  assert.equal(r.statusCode, 403)
  const r2 = await app.inject({ method: 'POST', url: '/api/loans/nope/return', headers: stranger, payload: {} })
  assert.equal(r2.statusCode, 404)
})

test('PATCH /api/me: город только из справочника, мусор — 400 (аудит 14.08.2026)', async () => {
  // Единственная пишущая ручка профиля не переиспользовала проверку по
  // справочнику: в City писалась любая строка любой длины при лимите тела 12 МБ,
  // а потом всплывала в выгрузке, карточках и подсчёте «экземпляров в городе».
  const me = { 'x-init-data': signInitData({ id: '555010' }) }
  const bad = await app.inject({ method: 'PATCH', url: '/api/me', headers: me, payload: { city: 'Атлантида' } })
  assert.equal(bad.statusCode, 400)
  assert.equal(JSON.parse(bad.body).error, 'unknown_city')

  const huge = await app.inject({
    method: 'PATCH',
    url: '/api/me',
    headers: me,
    payload: { city: 'W'.repeat(5000) },
  })
  assert.equal(huge.statusCode, 400, 'длинная строка тоже не должна доезжать до базы')

  const ok = await app.inject({ method: 'PATCH', url: '/api/me', headers: me, payload: { city: 'Radom' } })
  assert.equal(ok.statusCode, 200)
  assert.equal((await prisma.user.findUnique({ where: { tgId: 555010n } }))?.city, 'Radom')

  const cleared = await app.inject({ method: 'PATCH', url: '/api/me', headers: me, payload: { city: null } })
  assert.equal(cleared.statusCode, 200, 'сброс города остаётся возможным')
  assert.equal((await prisma.user.findUnique({ where: { tgId: 555010n } }))?.city, null)
})

/* ── мелкие находки аудита 14.08.2026 ─────────────────────── */

test('POST /api/loans: мусорный срок — понятный код, а не дамп Prisma', async () => {
  // `Number("abc")` = NaN → `new Date(NaN)` → Prisma кидала валидационную
  // ошибку, и её многострочный текст с внутренностями модели уезжал клиенту
  await prisma.user.upsert({ where: { tgId: 555020n }, create: { tgId: 555020n }, update: {} })
  const me = { 'x-init-data': signInitData({ id: '555020' }) }
  const r = await app.inject({
    method: 'POST',
    url: '/api/loans',
    headers: me,
    payload: { title: 'Дюна', holder: '@someone', days: 'abc' },
  })
  assert.equal(r.statusCode, 400)
  const body = JSON.parse(r.body)
  assert.equal(body.error, 'bad_days')
  assert.ok(!r.body.includes('prisma'), 'внутренности ORM наружу не уходят')
  assert.ok(!r.body.includes('Invalid'), 'сырое сообщение библиотеки наружу не уходит')
})

test('POST /api/loans: отрицательный и гигантский срок тоже отвергаются', async () => {
  const me = { 'x-init-data': signInitData({ id: '555020' }) }
  for (const days of [-5, 0, 100000]) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/loans',
      headers: me,
      payload: { title: 'Дюна', holder: '@someone', days },
    })
    assert.equal(r.statusCode, 400, `срок ${days} должен быть отвергнут`)
  }
})

test('админские ручки: нечисловой id — 400, а не 500 от BigInt()', async () => {
  const admin = { 'x-init-data': signInitData({ id: String(ADMIN_TG) }) }
  const r = await app.inject({
    method: 'POST',
    url: '/api/admin/users/не-число/restrict',
    headers: admin,
    payload: { scope: 'reviews', reason: 'проверка' },
  })
  assert.equal(r.statusCode, 400)
})

test('ограничение: мусорный срок не превращается в бессрочное молча', async () => {
  const admin = { 'x-init-data': signInitData({ id: String(ADMIN_TG) }) }
  await prisma.user.upsert({ where: { tgId: 555021n }, create: { tgId: 555021n }, update: {} })
  const r = await app.inject({
    method: 'POST',
    url: '/api/admin/users/555021/restrict',
    headers: admin,
    payload: { scope: 'reviews', reason: 'проверка', days: 'abc' },
  })
  assert.equal(r.statusCode, 400, 'непонятный срок — это ошибка ввода, а не «бессрочно»')

  const past = await app.inject({
    method: 'POST',
    url: '/api/admin/users/555021/restrict',
    headers: admin,
    payload: { scope: 'reviews', reason: 'проверка', days: -3 },
  })
  assert.equal(past.statusCode, 400, 'срок в прошлом — тихая пустышка с письмом человеку')
  assert.equal(await prisma.userRestriction.count({ where: { userTg: 555021n } }), 0)
})

test('подпись без auth_date не проходит (защита в глубину)', async () => {
  // сама подпись покрывает auth_date, подделать «без даты» нельзя — но и
  // принимать initData без отметки времени незачем: проверка свежести тогда
  // просто пропускается
  const params = new URLSearchParams({ user: JSON.stringify({ id: '555022' }) })
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join(String.fromCharCode(10))
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN!).digest()
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'))

  const r = await app.inject({ method: 'GET', url: '/api/loans', headers: { 'x-init-data': params.toString() } })
  assert.equal(r.statusCode, 401)
})

test('пустое тело при content-type: application/json — это {}, а не 400', async () => {
  // дефолтный парсер Fastify отвечал FST_ERR_CTP_EMPTY_JSON_BODY, и удаление
  // (тела там нет по определению) падало у любого клиента, который ставит
  // заголовок по умолчанию. Поймано дважды на ручных проверках прода
  await prisma.user.upsert({ where: { tgId: 555005n }, create: { tgId: 555005n }, update: {} })
  const headers = {
    'x-init-data': signInitData({ id: '555005' }),
    'content-type': 'application/json',
  }
  const book = await prisma.book.create({
    data: { title: 'Книга для пустого тела', kind: 'book', active: true, reviewStatus: 'approved' },
  })

  const r = await app.inject({
    method: 'DELETE',
    url: `/api/books/${book.id}/wait`,
    headers,
    payload: '',
  })
  assert.equal(r.statusCode, 200)
  assert.deepEqual(r.json().waiting, { count: 0, mine: null })
})

test('кривой JSON остаётся ошибкой 400', async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/me',
    headers: { 'content-type': 'application/json' },
    payload: '{не json',
  })
  assert.equal(r.statusCode, 400)
})
