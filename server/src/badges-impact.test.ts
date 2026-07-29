/**
 * Значки библиотекаря (issue #11) и «сколько сберегли вместе» (issue #13).
 *
 * Обе фичи считаются на лету из уже имеющихся данных, поэтому проверяется
 * именно это: детерминированность, границы порогов, отсутствие таблиц под
 * значки, методика оценки и приватность (значки — только про себя).
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

const DB_FILE = join(tmpdir(), `badges-test-${randomUUID()}.db`)
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
const { badgesFor, badgesOf, statsFor } = await import('./badges.js')
const {
  AVG_BOOK_PRICE_PLN,
  PAPER_PER_BOOK_KG,
  PAPER_PER_TREE_KG,
  computeImpact,
  impact,
  invalidateImpact,
} = await import('./impact.js')

const OWNER = 910001n
const READER = 910002n

function signInitData(user: { id: string; username?: string; first_name?: string }): string {
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

const asUser = (tg: bigint) => ({ 'x-init-data': signInitData({ id: String(tg) }) })

const app = Fastify()
const EMPTY = {
  booksOnShelf: 0,
  given: 0,
  returned: 0,
  read: 0,
  reviews: 0,
  readers: 0,
  onTime: 0,
  topRated: 0,
}
const byId = (list: { id: string; earned: boolean }[]) =>
  new Map(list.map((b) => [b.id, b.earned]))

before(async () => {
  await registerRoutes(app)
  await app.ready()
})

beforeEach(async () => {
  await prisma.review.deleteMany()
  await prisma.workRating.deleteMany()
  await prisma.waiting.deleteMany()
  await prisma.loanEvent.deleteMany()
  await prisma.loan.deleteMany()
  await prisma.book.deleteMany()
  await prisma.librarian.deleteMany()
  await prisma.user.deleteMany()
  for (const tgId of [OWNER, READER]) await prisma.user.create({ data: { tgId } })
  invalidateImpact()
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

/* ── значки (issue #11) ─────────────────────────────────── */

test('пустая полка: ни одного значка, но список показан целиком', () => {
  const badges = badgesFor(EMPTY)
  assert.ok(badges.length >= 5, 'значков хотя бы пять')
  assert.equal(
    badges.every((b) => !b.earned),
    true,
  )
  assert.equal(
    badges.every((b) => b.current === 0 && b.target > 0),
    true,
  )
})

test('порог срабатывает ровно на своём числе, а не рядом', () => {
  const nine = byId(badgesFor({ ...EMPTY, booksOnShelf: 9 }))
  const ten = byId(badgesFor({ ...EMPTY, booksOnShelf: 10 }))
  assert.equal(nine.get('shelf-10'), false)
  assert.equal(ten.get('shelf-10'), true)
  // первая книга при девяти уже заработана
  assert.equal(nine.get('first-book'), true)
  assert.equal(ten.get('shelf-25'), false)
})

test('прогресс не перескакивает цель: «12 из 10» выглядело бы сломанным', () => {
  const b = badgesFor({ ...EMPTY, booksOnShelf: 12 }).find((x) => x.id === 'shelf-10')!
  assert.deepEqual([b.current, b.target, b.earned], [10, 10, true])
})

test('значки детерминированы: те же числа — тот же ответ', () => {
  const stats = { ...EMPTY, booksOnShelf: 11, given: 3, returned: 2, read: 1, reviews: 4 }
  assert.deepEqual(badgesFor(stats), badgesFor(stats))
})

test('значки считаются из реальных данных полки и выдач', async () => {
  const librarian = await prisma.librarian.create({ data: { name: 'Владелец', tgId: OWNER } })
  for (let i = 0; i < 10; i++) {
    await prisma.book.create({
      data: {
        title: `Книга ${i}`,
        kind: 'book',
        active: true,
        reviewStatus: 'approved',
        ownerId: librarian.id,
      },
    })
  }
  // книга на модерации в счёт не идёт: значок должен отражать живую полку
  await prisma.book.create({
    data: {
      title: 'На проверке',
      kind: 'book',
      active: true,
      reviewStatus: 'pending',
      ownerId: librarian.id,
    },
  })
  await prisma.loan.create({
    data: { title: 'Книга 0', ownerTg: OWNER, holderTg: READER, status: 'returned' },
  })

  const stats = await statsFor(OWNER)
  assert.deepEqual(stats, {
    booksOnShelf: 10,
    given: 1,
    returned: 1,
    read: 0,
    reviews: 0,
    readers: 1,
    onTime: 0,
    topRated: 0,
  })

  const { badges } = await badgesOf(OWNER)
  const map = byId(badges)
  assert.equal(map.get('shelf-10'), true)
  assert.equal(map.get('first-lend'), true)
  assert.equal(map.get('lend-5'), false)
  assert.equal(map.get('reader-3'), false)
})

test('прочитанные чужие книги и оценки считаются читателю, а не владельцу', async () => {
  for (let i = 0; i < 3; i++) {
    await prisma.loan.create({
      data: { title: `Книга ${i}`, ownerTg: OWNER, holderTg: READER, status: 'returned' },
    })
  }
  await prisma.review.create({
    data: { workKey: 'дюна|герберт', authorTg: READER, rating: 5 },
  })

  const reader = byId((await badgesOf(READER)).badges)
  assert.equal(reader.get('reader-3'), true)
  assert.equal(reader.get('first-review'), true)

  const owner = byId((await badgesOf(OWNER)).badges)
  assert.equal(owner.get('reader-3'), false)
  assert.equal(owner.get('first-review'), false)
})

test('«книжный друг» считает людей, а не выдачи', async () => {
  // десять книг одному человеку — это не то же самое, что по книге десятерым
  for (let i = 0; i < 4; i++) {
    await prisma.loan.create({
      data: { title: `Книга ${i}`, ownerTg: OWNER, holderTg: READER, status: 'returned' },
    })
  }
  assert.equal((await statsFor(OWNER)).readers, 1)
  assert.equal(byId((await badgesOf(OWNER)).badges).get('friend-3'), false)

  await prisma.user.create({ data: { tgId: 910003n } })
  await prisma.loan.create({ data: { title: 'Ещё', ownerTg: OWNER, holderTg: 910003n } })
  // третий читатель — пока только по нику: id появится, когда он зайдёт в бота
  await prisma.loan.create({ data: { title: 'И ещё', ownerTg: OWNER, holderUsername: 'anna' } })

  assert.equal((await statsFor(OWNER)).readers, 3)
  assert.equal(byId((await badgesOf(OWNER)).badges).get('friend-3'), true)
})

test('«хранитель полки»: считаются только книги, вернувшиеся в срок', async () => {
  const due = new Date('2026-07-20T12:00:00Z')
  // две вовремя
  for (const back of ['2026-07-19T10:00:00Z', '2026-07-20T11:00:00Z']) {
    await prisma.loan.create({
      data: {
        title: 'Вовремя',
        ownerTg: OWNER,
        holderTg: READER,
        status: 'returned',
        dueAt: due,
        returnedAt: new Date(back),
      },
    })
  }
  // одна с опозданием — она не должна попасть в счёт
  await prisma.loan.create({
    data: {
      title: 'С опозданием',
      ownerTg: OWNER,
      holderTg: READER,
      status: 'returned',
      dueAt: due,
      returnedAt: new Date('2026-07-25T10:00:00Z'),
    },
  })
  // и одна вообще без срока: её нельзя назвать ни срочной, ни просроченной
  await prisma.loan.create({
    data: { title: 'Без срока', ownerTg: OWNER, holderTg: READER, status: 'returned' },
  })

  assert.equal((await statsFor(OWNER)).onTime, 2)
  assert.equal(byId((await badgesOf(OWNER)).badges).get('keeper'), false)

  await prisma.loan.create({
    data: {
      title: 'Третья вовремя',
      ownerTg: OWNER,
      holderTg: READER,
      status: 'returned',
      dueAt: due,
      returnedAt: new Date('2026-07-18T10:00:00Z'),
    },
  })
  assert.equal(byId((await badgesOf(OWNER)).badges).get('keeper'), true)
})

test('«редкая находка»: чужая пятёрка книге с полки, своя не считается', async () => {
  const librarian = await prisma.librarian.create({ data: { name: 'Владелец', tgId: OWNER } })
  await prisma.book.create({
    data: {
      title: 'Дюна',
      author: 'Герберт',
      kind: 'book',
      active: true,
      reviewStatus: 'approved',
      ownerId: librarian.id,
    },
  })
  const workKey = 'дюна|герберт'

  // сам себе пятёрку поставить можно, но значка это не даёт
  await prisma.review.create({ data: { workKey, authorTg: OWNER, rating: 5 } })
  assert.equal((await statsFor(OWNER)).topRated, 0)

  await prisma.review.create({ data: { workKey, authorTg: READER, rating: 5 } })
  assert.equal((await statsFor(OWNER)).topRated, 1)
  assert.equal(byId((await badgesOf(OWNER)).badges).get('rare-find'), true)
})

test('скрытый по жалобам отзыв значка не даёт', async () => {
  const librarian = await prisma.librarian.create({ data: { name: 'Владелец', tgId: OWNER } })
  await prisma.book.create({
    data: {
      title: 'Дюна',
      author: 'Герберт',
      kind: 'book',
      active: true,
      reviewStatus: 'approved',
      ownerId: librarian.id,
    },
  })
  await prisma.review.create({
    data: { workKey: 'дюна|герберт', authorTg: READER, rating: 5, status: 'hidden' },
  })
  assert.equal((await statsFor(OWNER)).topRated, 0)
})

test('у каждого значка есть своя картинка', async () => {
  const { readdirSync } = await import('node:fs')
  const files = new Set(readdirSync('../web/public/ach'))
  for (const b of badgesFor(EMPTY)) {
    assert.ok(files.has(`${b.id}.webp`), `нет картинки для значка ${b.id}`)
  }
})

test('значки — только про себя: без подписи 401, чужие не отдаются', async () => {
  const anon = await app.inject({ method: 'GET', url: '/api/my-badges' })
  assert.equal(anon.statusCode, 401)

  const mine = await app.inject({ method: 'GET', url: '/api/my-badges', headers: asUser(READER) })
  assert.equal(mine.statusCode, 200)
  const body = mine.json()
  assert.ok(Array.isArray(body.badges))
  // в ответе нет ни одного чужого идентификатора
  assert.ok(!mine.body.includes(String(OWNER)))
})

test('значки не требуют своей таблицы: их негде «потерять»', () => {
  const tables = Object.keys(prisma).filter((k) => !k.startsWith('$') && !k.startsWith('_'))
  assert.ok(!tables.some((t) => t.toLowerCase().includes('badge')), 'таблицы под значки нет')
})

/* ── сколько сберегли вместе (issue #13) ────────────────── */

test('методика: обмены умножаются на честно подписанные коэффициенты', () => {
  const r = computeImpact(100)
  assert.equal(r.exchanges, 100)
  assert.equal(r.moneyPln, 100 * AVG_BOOK_PRICE_PLN)
  assert.equal(r.paperKg, Math.round(100 * PAPER_PER_BOOK_KG * 10) / 10)
  assert.equal(r.trees, Math.round(((100 * PAPER_PER_BOOK_KG) / PAPER_PER_TREE_KG) * 10) / 10)
  assert.deepEqual(r.basis, {
    pricePln: AVG_BOOK_PRICE_PLN,
    paperPerBookKg: PAPER_PER_BOOK_KG,
    paperPerTreeKg: PAPER_PER_TREE_KG,
  })
})

test('нет обменов — нет и оценки; мусор на входе не ломает счёт', () => {
  assert.deepEqual(
    [computeImpact(0).moneyPln, computeImpact(-5).exchanges, computeImpact(NaN).trees],
    [0, 0, 0],
  )
})

const decimals = (n: number) => (String(n).split('.')[1] ?? '').length

test('числа округлены до читаемых: без 12.300000000000001', () => {
  const r = computeImpact(41)
  assert.equal(r.paperKg, 12.3)
  assert.ok(decimals(r.paperKg) <= 1, `кг бумаги: ${r.paperKg}`)
  assert.ok(decimals(r.trees) <= 2, `деревья: ${r.trees}`)
  assert.ok(Number.isInteger(r.moneyPln), `злотые: ${r.moneyPln}`)
})

test('деревья не схлопываются в ноль на первых обменах', () => {
  // одно дерево — это две сотни книг; при округлении до десятых первые полторы
  // сотни обменов показывали бы «примерно 0 деревьев», что обиднее, чем честно
  assert.ok(computeImpact(1).trees > 0, 'один обмен уже что-то значит')
  assert.equal(computeImpact(200).trees, 1)
})

test('цифра растёт с обменами и кэш этого не прячет', async () => {
  const before = await impact()
  assert.equal(before.exchanges, 0)

  await prisma.loan.create({ data: { title: 'Дюна', ownerTg: OWNER, holderUsername: 'reader' } })
  // без сброса кэша ответ остался бы прежним — сброс делает createLoan
  invalidateImpact()
  const after = await impact()
  assert.equal(after.exchanges, 1)
  assert.equal(after.moneyPln, AVG_BOOK_PRICE_PLN)
  assert.ok(after.trees > 0)
})

test('кэш держит ответ несколько минут, но не дольше', async () => {
  await prisma.loan.create({ data: { title: 'Дюна', ownerTg: OWNER, holderUsername: 'r' } })
  const t0 = Date.now()
  const first = await impact(t0)
  await prisma.loan.create({ data: { title: 'Солярис', ownerTg: OWNER, holderUsername: 'r2' } })
  assert.equal((await impact(t0 + 60_000)).exchanges, first.exchanges, 'внутри окна — из кэша')
  assert.equal((await impact(t0 + 6 * 60_000)).exchanges, 2, 'после окна — свежий счёт')
})

test('«сколько сберегли» публично и не содержит ни одного человека', async () => {
  await prisma.loan.create({
    data: { title: 'Дюна', ownerTg: OWNER, holderTg: READER, status: 'returned' },
  })
  invalidateImpact()
  const res = await app.inject({ method: 'GET', url: '/api/impact' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().exchanges, 1)
  for (const tg of [OWNER, READER]) assert.ok(!res.body.includes(String(tg)))
})
