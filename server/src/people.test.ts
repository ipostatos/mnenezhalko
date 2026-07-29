/**
 * Подсказка людей при вводе ника («у кого моя книга»).
 *
 * Главное здесь не удобство, а граница: подсказывать можно библиотекарей (их
 * ники и так в открытой таблице проекта) и тех, кому спрашивающий уже давал
 * книги. Все, кто просто открывал бота, в подсказку попадать не должны — иначе
 * форма выдачи превращается в справочник ников.
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

const DB_FILE = join(tmpdir(), `people-test-${randomUUID()}.db`)
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
const { PEOPLE_LIMIT, suggestPeople } = await import('./people.js')

const ME = 920001n
const STRANGER = 920002n

function signInitData(user: { id: string }): string {
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
const handles = (list: { telegram: string }[]) => list.map((p) => p.telegram)

before(async () => {
  await registerRoutes(app)
  await app.ready()
})

beforeEach(async () => {
  await prisma.loanEvent.deleteMany()
  await prisma.loan.deleteMany()
  await prisma.book.deleteMany()
  await prisma.librarian.deleteMany()
  await prisma.user.deleteMany()
  await prisma.user.create({ data: { tgId: ME, username: 'me' } })
  await prisma.user.create({ data: { tgId: STRANGER, username: 'sofia_kowalczyk_warszawa' } })
  await prisma.librarian.create({
    data: {
      name: 'Лиза Ж',
      telegram: 'LizavetaZh',
      telegramNorm: 'lizavetazh',
      city: 'Warszawa',
    },
  })
  await prisma.librarian.create({
    data: {
      name: 'Анна Ковальчик',
      telegram: 'anna_kowalczyk_books',
      telegramNorm: 'anna_kowalczyk_books',
      city: 'Kraków',
    },
  })
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

test('длинный ник находится по первым буквам', async () => {
  const found = await suggestPeople(ME, 'anna')
  assert.deepEqual(handles(found), ['anna_kowalczyk_books'])
})

test('ищем и по имени: ник часто не похож на человека', async () => {
  assert.deepEqual(handles(await suggestPeople(ME, 'Лиза')), ['lizavetazh'])
})

test('регистр и собачка не мешают', async () => {
  assert.deepEqual(handles(await suggestPeople(ME, '@LIZAVETAZH')), ['lizavetazh'])
})

test('пустой запрос ничего не подсказывает: это была бы выгрузка ников', async () => {
  assert.deepEqual(await suggestPeople(ME, ''), [])
  assert.deepEqual(await suggestPeople(ME, '   '), [])
})

test('те, кто просто открывал бота, в подсказку не попадают', async () => {
  // у STRANGER подходящий ник, но он никому не библиотекарь и книг у нас не брал
  const found = await suggestPeople(ME, 'sofia')
  assert.deepEqual(found, [])
})

test('свой прошлый читатель подсказывается и стоит выше справочника', async () => {
  await prisma.loan.create({
    data: {
      title: 'Дюна',
      ownerTg: ME,
      holderUsername: 'anna_kowalczyk_books',
      holderName: 'Аня с работы',
      status: 'returned',
    },
  })
  const found = await suggestPeople(ME, 'anna')
  assert.deepEqual(handles(found), ['anna_kowalczyk_books'])
  // имя берём из своей истории: так человек узнаёт того, кому давал книгу
  assert.equal(found[0].name, 'Аня с работы')
  assert.equal(found[0].source, 'history')
})

test('чужая история чужому не подсказывается', async () => {
  await prisma.loan.create({
    data: {
      title: 'Дюна',
      ownerTg: STRANGER,
      holderUsername: 'sofia_kowalczyk_warszawa',
      holderName: 'София',
      status: 'returned',
    },
  })
  assert.deepEqual(await suggestPeople(ME, 'sofia'), [])
  assert.deepEqual(handles(await suggestPeople(STRANGER, 'sofia')), ['sofia_kowalczyk_warszawa'])
})

test('себя в подсказках не показываем: себе книгу не отдают', async () => {
  await prisma.librarian.create({
    data: { name: 'Я сам', telegram: 'me', telegramNorm: 'me', tgId: ME },
  })
  assert.deepEqual(handles(await suggestPeople(ME, 'me')), [])
})

test('архивные дубли библиотекарей не подсказываются', async () => {
  await prisma.librarian.create({
    data: {
      name: 'Лиза Ж (дубль)',
      telegram: 'LizavetaZh',
      telegramNorm: 'lizavetazh',
      mergedIntoId: 'какая-то-главная-запись',
    },
  })
  const found = await suggestPeople(ME, 'lizaveta')
  assert.equal(found.length, 1)
  assert.equal(found[0].name, 'Лиза Ж')
})

test('подсказок не больше восьми: длинный список на телефоне бесполезен', async () => {
  for (let i = 0; i < 15; i++) {
    await prisma.librarian.create({
      data: {
        name: `Книжник ${i}`,
        telegram: `booklover_${i}`,
        telegramNorm: `booklover_${i}`,
      },
    })
  }
  assert.equal((await suggestPeople(ME, 'booklover')).length, PEOPLE_LIMIT)
})

test('ручка: без подписи 401, с подписью отдаёт только имя и ник', async () => {
  const anon = await app.inject({ method: 'GET', url: '/api/people?q=anna' })
  assert.equal(anon.statusCode, 401)

  const res = await app.inject({
    method: 'GET',
    url: '/api/people?q=anna',
    headers: { 'x-init-data': signInitData({ id: String(ME) }) },
  })
  assert.equal(res.statusCode, 200)
  const [person] = res.json().people
  assert.deepEqual(Object.keys(person).sort(), ['name', 'source', 'telegram'])
  // ни числовых id, ни городов наружу не уходит
  for (const leak of [String(ME), String(STRANGER), 'Kraków']) {
    assert.ok(!res.body.includes(leak), `в ответе не должно быть «${leak}»`)
  }
})
