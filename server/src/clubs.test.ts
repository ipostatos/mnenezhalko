/**
 * Книжные клубы и рубильник донатов (B5 и B7, ТЗ 5.08.2026).
 *
 * B7: клуб перестал быть единственным. Проверяем, что список читается из
 * настройки, что два клуба ОДНОГО города не схлопываются и не путаются
 * ссылками, что опечатка в настройке не роняет сервер (иначе из-за неверной
 * запятой у людей пропал бы весь бот), и что старый CLUB_URL продолжает
 * работать — прод не должен остаться без клуба, пока настройку не поменяли.
 *
 * B5: пользовательских входов в донат быть не должно, а ручка обязана отвечать
 * feature_disabled — выключенная функция не отличается от несуществующей.
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

const DB_FILE = join(tmpdir(), `clubs-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'
process.env.BOT_TOKEN = '123456:test-token-for-signature'
process.env.NOTION_TOKEN_V2 = ''
const PERSON = 994001n

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { env } = await import('./env.js')
const { registerRoutes } = await import('./routes.js')
const { activeClubs, allClubs, clubById, primaryClubUrl, resetClubsCache } = await import(
  './clubs.js'
)

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

const TWO_IN_ONE_CITY = JSON.stringify([
  { id: 'wwa-evening', name: 'Вечерний клуб', city: 'Warszawa', url: 'https://t.me/wwa_evening' },
  {
    id: 'wwa-morning',
    name: 'Утренний клуб',
    city: 'Warszawa',
    url: 'https://t.me/wwa_morning',
    description: 'Читаем по субботам',
    sortOrder: 1,
  },
  { id: 'krk', name: 'Краковский клуб', city: 'Kraków', url: 'https://t.me/krk_club' },
  { id: 'old', name: 'Закрытый клуб', city: 'Kraków', url: 'https://t.me/old', active: false },
])

before(async () => {
  await registerRoutes(app)
  await app.ready()
})

beforeEach(() => {
  delete process.env.CLUBS_JSON
  delete process.env.CLUB_URL
  resetClubsCache()
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

test('два клуба одного города видны отдельно и не путаются ссылками', async () => {
  process.env.CLUBS_JSON = TWO_IN_ONE_CITY
  resetClubsCache()

  const wwa = activeClubs().filter((c) => c.city === 'Warszawa')
  assert.equal(wwa.length, 2, 'город не должен схлопывать клубы в один')
  assert.deepEqual(
    wwa.map((c) => [c.name, c.url]),
    [
      ['Утренний клуб', 'https://t.me/wwa_morning'], // sortOrder=1 поднимает выше
      ['Вечерний клуб', 'https://t.me/wwa_evening'],
    ],
  )
})

test('выключенный клуб людям не показываем, но из настройки не теряем', () => {
  process.env.CLUBS_JSON = TWO_IN_ONE_CITY
  resetClubsCache()
  assert.equal(allClubs().length, 4)
  assert.equal(activeClubs().length, 3)
  assert.equal(
    activeClubs().some((c) => c.id === 'old'),
    false,
  )
})

test('встреча ведёт в КОНКРЕТНЫЙ клуб по id, а не «в клуб города»', () => {
  process.env.CLUBS_JSON = TWO_IN_ONE_CITY
  resetClubsCache()
  assert.equal(clubById('wwa-morning')?.url, 'https://t.me/wwa_morning')
  assert.equal(clubById('wwa-evening')?.url, 'https://t.me/wwa_evening')
  assert.equal(clubById('old'), null, 'выключенный клуб — не цель для ссылки')
  assert.equal(clubById(null), null)
})

test('старый CLUB_URL продолжает работать, пока настройку не поменяли', () => {
  process.env.CLUB_URL = 'https://t.me/bookclub_mnzh'
  resetClubsCache()
  const clubs = activeClubs()
  assert.equal(clubs.length, 1)
  assert.equal(clubs[0].url, 'https://t.me/bookclub_mnzh')
  assert.equal(primaryClubUrl(), 'https://t.me/bookclub_mnzh')
})

test('опечатка в списке не роняет сервер: остаёмся на старом адресе', () => {
  process.env.CLUBS_JSON = '[{"id":"broken","name":"Без ссылки","city":"Warszawa"}]'
  process.env.CLUB_URL = 'https://t.me/bookclub_mnzh'
  resetClubsCache()
  const clubs = activeClubs()
  assert.equal(clubs.length, 1)
  assert.equal(clubs[0].url, 'https://t.me/bookclub_mnzh')
})

test('не-http адрес клуба не принимаем (в кнопку уедет что угодно)', () => {
  process.env.CLUBS_JSON =
    '[{"id":"x","name":"Клуб","city":"Warszawa","url":"javascript:alert(1)"}]'
  process.env.CLUB_URL = 'https://t.me/bookclub_mnzh'
  resetClubsCache()
  assert.equal(activeClubs()[0].url, 'https://t.me/bookclub_mnzh')
})

test('/api/clubs отдаёт список и не отдаёт выключенные', async () => {
  process.env.CLUBS_JSON = TWO_IN_ONE_CITY
  resetClubsCache()
  const res = await app.inject({ method: 'GET', url: '/api/clubs' })
  assert.equal(res.statusCode, 200)
  const list = res.json() as Array<{ id: string; city: string }>
  assert.deepEqual(
    list.map((c) => c.id),
    ['krk', 'wwa-morning', 'wwa-evening'], // сортировка по городу, внутри — sortOrder
  )
  assert.equal(list.filter((c) => c.city === 'Warszawa').length, 2)
})

test('донаты выключены: ручка отвечает feature_disabled даже с валидной подписью', async () => {
  env.donations = false
  const res = await app.inject({
    method: 'POST',
    url: '/api/donate/link',
    headers: asUser(PERSON),
    payload: { amount: 50 },
  })
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().error, 'feature_disabled')
})

test('донаты включены: платёжный путь жив (DONATIONS_ENABLED=1)', async () => {
  env.donations = true
  const res = await app.inject({
    method: 'POST',
    url: '/api/donate/link',
    headers: asUser(PERSON),
    payload: { amount: 12345 }, // суммы нет в whitelist
  })
  // важно: НЕ feature_disabled — рубильник пропустил, отказала проверка суммы
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error, 'bad_amount')
  env.donations = false
})

test('health говорит приложению правду про донаты и число клубов', async () => {
  process.env.CLUBS_JSON = TWO_IN_ONE_CITY
  resetClubsCache()
  env.donations = false
  const h = (await app.inject({ method: 'GET', url: '/api/health' })).json()
  assert.equal(h.donations, false)
  assert.equal(h.clubs, 3)
})
