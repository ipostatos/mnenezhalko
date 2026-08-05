/**
 * Пустая карточка в витрине библиотеки (A3, ТЗ 5.08.2026).
 *
 * ПЕРВОПРИЧИНА, найденная на проде, а не предположенная: магазин отдаёт по
 * адресу обложки НАСТОЯЩИЙ файл — серый квадрат с надписью «Brak zdjęcia» —
 * с кодом 200 и типом image/*. Ни `onError` у браузера, ни проверка кода
 * ответа такое не ловят: 54 книги каталога ссылались на одну такую картинку
 * (все на ecsmedia.pl, CDN Empik; нашлось сравнением файлов кэша превью).
 *
 * Здесь проверяются все четыре способа «остаться без картинки», которые может
 * увидеть витрина, и то, что ни один не превращается в пустой слот:
 *   1) обложки нет вовсе (coverUrl пуст);
 *   2) ссылка битая / файл удалён — origin отвечает 404;
 *   3) origin отвечает не картинкой;
 *   4) origin отвечает картинкой-заглушкой.
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
import sharp from 'sharp'

const DB_FILE = join(tmpdir(), `coverstub-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'
process.env.BOT_TOKEN = '123456:test-token-for-signature'
process.env.NOTION_TOKEN_V2 = ''

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { registerRoutes, resetShowcaseCache } = await import('./routes.js')
const { looksLikeStubCover, rememberStubCover, stubCoverUrls, forgetStubCoverCache } = await import(
  './cover-quality.js'
)

const app = Fastify()

/** Заглушка магазина: почти одноцветный квадрат с бледной «иконкой». */
async function stubImage(size = 320): Promise<Buffer> {
  const icon = Buffer.from(
    `<svg width="${size}" height="${size}"><rect width="100%" height="100%" fill="#f5f5f5"/>` +
      `<rect x="${size * 0.4}" y="${size * 0.45}" width="${size * 0.2}" height="${size * 0.12}" fill="#e8e8e8"/></svg>`,
  )
  return sharp(icon).webp().toBuffer()
}

/** Настоящая обложка: пёстрая картинка (шум + цвет), как любой реальный скан. */
async function realImage(w = 320, h = 500): Promise<Buffer> {
  const px = Buffer.alloc(w * h * 3)
  for (let i = 0; i < px.length; i++) px[i] = (i * 37 + ((i / 7) | 0) * 91) % 256
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).webp().toBuffer()
}

before(async () => {
  await registerRoutes(app)
  await app.ready()
})

beforeEach(async () => {
  await prisma.book.deleteMany()
  await prisma.librarian.deleteMany()
  await prisma.syncState.deleteMany()
  forgetStubCoverCache()
  resetShowcaseCache() // витрина живёт 30 минут — иначе тест увидит чужую подборку
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

test('картинку-заглушку отличаем от настоящей обложки по содержимому', async () => {
  assert.equal(await looksLikeStubCover(await stubImage()), true, 'серый квадрат — заглушка')
  assert.equal(await looksLikeStubCover(await stubImage(96)), true, 'и в размере списка тоже')
  assert.equal(await looksLikeStubCover(await realImage()), false, 'пёстрая обложка — не заглушка')
})

test('мусор вместо картинки не объявляем заглушкой (не смогли посмотреть ≠ пусто)', async () => {
  assert.equal(await looksLikeStubCover(Buffer.from('это вообще не картинка')), false)
})

test('реестр заглушек переживает перезапуск процесса и не растёт от повторов', async () => {
  const url = 'https://ecsmedia.pl/c/brak-zdjecia.jpg'
  await rememberStubCover(url)
  await rememberStubCover(url) // идемпотентность
  forgetStubCoverCache() // как будто процесс перезапустили
  const known = await stubCoverUrls()
  assert.equal(known.has(url), true)
  const row = await prisma.syncState.findUnique({ where: { key: 'cover:stub-urls' } })
  assert.deepEqual(JSON.parse(row!.value), [url])
})

async function seedBook(title: string, coverUrl: string | null) {
  const owner = await prisma.librarian.create({ data: { name: `Полка ${title}`, city: 'Warszawa' } })
  return prisma.book.create({
    data: {
      title,
      kind: 'book',
      source: 'bot',
      active: true,
      reviewStatus: 'approved',
      city: 'Warszawa',
      coverUrl,
      ownerId: owner.id,
    },
  })
}

test('витрина: книга без обложки и книга с заглушкой в карусель не попадают', async () => {
  await seedBook('С нормальной обложкой', 'https://example.org/cover-ok.jpg')
  await seedBook('Без обложки вовсе', null)
  await seedBook('С пустой строкой вместо обложки', '')
  await seedBook('С заглушкой магазина', 'https://ecsmedia.pl/c/brak-zdjecia.jpg')
  await rememberStubCover('https://ecsmedia.pl/c/brak-zdjecia.jpg')

  const res = await app.inject({ method: 'GET', url: '/api/showcase' })
  assert.equal(res.statusCode, 200)
  const titles = res.json().map((b: { title: string }) => b.title)
  assert.deepEqual(titles, ['С нормальной обложкой'])
})

test('витрина не ломается, когда валидных обложек не осталось совсем', async () => {
  await seedBook('Только заглушка', 'https://ecsmedia.pl/c/brak-zdjecia.jpg')
  await rememberStubCover('https://ecsmedia.pl/c/brak-zdjecia.jpg')

  const res = await app.inject({ method: 'GET', url: '/api/showcase' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), [], 'пустая витрина лучше витрины из дырок')
})

test('заглушку, найденную ПОСЛЕ съёмки витрины, из готовой подборки тоже убираем', async () => {
  const good = await seedBook('Хорошая', 'https://example.org/ok.jpg')
  const bad = await seedBook('Станет заглушкой', 'https://ecsmedia.pl/c/later.jpg')
  // витрина уже снята и лежит в SyncState (так она переживает деплой)
  await prisma.syncState.create({
    data: {
      key: 'showcase:*:12',
      value: JSON.stringify([
        { id: good.id, title: good.title, coverUrl: good.coverUrl },
        { id: bad.id, title: bad.title, coverUrl: bad.coverUrl },
      ]),
    },
  })
  await rememberStubCover('https://ecsmedia.pl/c/later.jpg')

  const res = await app.inject({ method: 'GET', url: '/api/showcase' })
  const titles = res.json().map((b: { title: string }) => b.title)
  assert.deepEqual(titles, ['Хорошая'])
})

test('битая ссылка и не-картинка отвечают не-200: карточка выбывает через onError', async () => {
  const { cachedImage, negativeTtlMs } = await import('./imgcache.js')
  // подпись не сходится — сюда клиент попасть не должен вовсе
  assert.equal(await cachedImage('https://example.org/x.jpg', 320, 'подделка'), null)
  // 404 у origin и «не картинка» держатся в негативном кэше сутками —
  // origin не долбим на каждый заход
  assert.equal(negativeTtlMs('http_error', 404), 24 * 3600_000)
  assert.equal(negativeTtlMs('bad_content_type'), 24 * 3600_000)
  assert.equal(negativeTtlMs('stub_image'), 24 * 3600_000)
})
