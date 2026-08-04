/**
 * Справочник агломераций: пригород → город проекта.
 *
 * Поводом было живое объявление 30 июля 2026: «Величка» (Wieliczka под Краковом)
 * уехала в район, городом стало «Все города», и человек с фильтром «только
 * Kraków» этого объявления не увидел.
 *
 * Проверяется не столько таблица, сколько правила вокруг неё: привязку даёт
 * только запись в справочнике, название-двойник привязки не даёт вовсе,
 * неизвестный посёлок сохраняется как написан, а объявление с ним остаётся
 * в разделе «Все города».
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
import Fastify from 'fastify'

const DB_FILE = join(tmpdir(), `agglomeration-test-${randomUUID()}.db`)
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
const { lookupPlace, describePlace, normalizePlace, AMBIGUOUS } = await import('./agglomeration.js')
const { resolvePlace, saveOffer } = await import('./market.js')

const app = Fastify()
const AUTHOR = 993010n

before(async () => {
  await registerRoutes(app)
  await app.ready()
})

beforeEach(async () => {
  await prisma.marketItem.deleteMany()
  await prisma.user.deleteMany()
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

/* ── справочник ───────────────────────────────────────────── */

test('пригород из справочника даёт город проекта', () => {
  const hit = lookupPlace('Wieliczka')
  assert.equal(hit?.city, 'Kraków')
  assert.equal(hit?.locality, 'Wieliczka')
  assert.equal(describePlace(hit!.city!, hit!.locality), 'Kraków (Wieliczka)')
})

test('написание не мешает: регистр, диакритика, кириллица', () => {
  assert.equal(lookupPlace('wieliczka')?.city, 'Kraków')
  assert.equal(lookupPlace('  ВЕЛИЧКА ')?.city, 'Kraków')
  // ł под NFD не раскладывается — если забыть про неё, «Lomianki» не найдётся
  assert.equal(lookupPlace('Lomianki')?.city, 'Warszawa')
  assert.equal(lookupPlace('Łomianki')?.locality, 'Łomianki', 'в карточку идёт каноническое написание')
  assert.equal(normalizePlace('Łomianki'), normalizePlace('lomianki'))
})

test('город Трёхградья привязывается к Trójmiasto и остаётся в подписи', () => {
  const hit = lookupPlace('Gdańsk')
  assert.equal(hit?.city, 'Trójmiasto')
  assert.equal(describePlace(hit!.city!, hit!.locality), 'Trójmiasto (Gdańsk)')
})

test('сам город проекта: город без пригорода в подписи', () => {
  const hit = lookupPlace('Kraków')
  assert.equal(hit?.city, 'Kraków')
  assert.equal(describePlace('Kraków', hit!.locality), 'Kraków', 'не «Kraków (Kraków)»')
})

test('название-двойник привязки НЕ даёт', () => {
  // Michałowice есть и под Варшавой, и под Краковом: по одному слову
  // города не знает никто, поэтому справочник обязан промолчать
  const hit = lookupPlace('Michałowice')
  assert.equal(hit?.city, null)
  assert.equal(hit?.ambiguous, true)
  assert.ok(AMBIGUOUS.has(normalizePlace('Michałowice')))
  assert.equal(hit?.locality, 'Michałowice', 'название всё равно сохраняем')
})

test('неизвестный населённый пункт: города нет, название сохранено', () => {
  const hit = lookupPlace('Козья Горка')
  assert.equal(hit?.city, null)
  assert.equal(hit?.ambiguous, false, 'это не двойник, а просто нет записи')
  assert.equal(hit?.locality, 'Козья Горка')
})

test('пустое место — не место', () => {
  assert.equal(lookupPlace(''), null)
  assert.equal(lookupPlace('   '), null)
  assert.equal(lookupPlace(null), null)
  assert.equal(lookupPlace(undefined), null)
})

/* ── разбор места объявления ──────────────────────────────── */

test('живой случай 30 июля: пригород приехал в поле района', () => {
  // именно так его и вернула модель: city пустой, «Величка» в district
  const p = resolvePlace({ city: '', district: 'Величка', locality: '' })
  assert.equal(p.city, 'Kraków')
  assert.equal(p.locality, 'Wieliczka')
  assert.equal(p.district, null, 'из района убрано: иначе задвоится в заголовке и в подписи')
})

test('район города остаётся районом', () => {
  const p = resolvePlace({ city: 'Warszawa', district: 'Wola', locality: '' })
  assert.equal(p.city, 'Warszawa')
  assert.equal(p.district, 'Wola')
  assert.equal(p.locality, null)
})

test('город проекта важнее пригорода в тексте', () => {
  const p = resolvePlace({ city: 'Kraków', district: '', locality: 'Wieliczka' })
  assert.equal(p.city, 'Kraków')
  assert.equal(p.locality, null, 'город назван прямо — приписка не нужна')
})

test('неизвестное место: «Все города», но название не теряется', () => {
  const p = resolvePlace({ city: '', district: '', locality: 'Козья Горка' })
  assert.equal(p.city, 'Все города')
  assert.equal(p.locality, 'Козья Горка')
})

test('двойник не привязывается и на разборе объявления', () => {
  const p = resolvePlace({ city: '', district: '', locality: 'Michałowice' })
  assert.equal(p.city, 'Все города', 'ближайший город не выдумываем')
  assert.equal(p.locality, 'Michałowice')
})

test('места нет вовсе', () => {
  const p = resolvePlace({ city: '', district: '', locality: '' })
  assert.equal(p.city, 'Все города')
  assert.equal(p.locality, null)
  assert.equal(p.district, null)
})

/* ── что видит человек ────────────────────────────────────── */

test('объявление из пригорода находится фильтром города', async () => {
  await prisma.user.create({ data: { tgId: AUTHOR, username: 'seller', firstName: 'Продавец' } })
  const saved = await saveOffer(
    {
      kind: 'give',
      title: 'Стеллаж под книги',
      description: 'Самовывоз',
      price: null,
      ...resolvePlace({ city: '', district: 'Величка', locality: '' }),
    },
    { id: 30001, authorTg: AUTHOR, authorUsername: 'seller', firstName: 'Продавец', photo: null },
  )
  assert.equal(saved?.city, 'Kraków')
  assert.equal(saved?.locality, 'Wieliczka')
  assert.equal(saved?.title, 'Стеллаж под книги', 'пригород больше не приписывается к заголовку')

  const res = await app.inject({ method: 'GET', url: '/api/market?city=Kraków' })
  const items = res.json() as Array<{ title: string; city: string; locality: string | null }>
  assert.equal(items.length, 1, 'до фикса объявление в этот список не попадало')
  assert.equal(items[0].locality, 'Wieliczka', 'подпись «Kraków (Wieliczka)» собирается на клиенте')
})

test('объявление с неизвестным городом видно в общем списке', async () => {
  await prisma.user.create({ data: { tgId: AUTHOR, username: 'seller', firstName: 'Продавец' } })
  await saveOffer(
    {
      kind: 'give',
      title: 'Коробка книг',
      description: null,
      price: null,
      ...resolvePlace({ city: '', district: '', locality: 'Козья Горка' }),
    },
    { id: 30002, authorTg: AUTHOR, authorUsername: 'seller', firstName: 'Продавец', photo: null },
  )

  const all = (await app.inject({ method: 'GET', url: '/api/market' })).json() as Array<{
    city: string
    locality: string | null
  }>
  assert.equal(all.length, 1)
  assert.equal(all[0].city, 'Все города')
  assert.equal(all[0].locality, 'Козья Горка')

  const filtered = (await app.inject({ method: 'GET', url: '/api/market?city=Kraków' })).json() as unknown[]
  assert.equal(filtered.length, 0, 'в чужой город такое объявление не подмешиваем')
})
