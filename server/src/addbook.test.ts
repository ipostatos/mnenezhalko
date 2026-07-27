/**
 * Тесты трёх жалоб от 27 июля 2026. Запуск: npm run test -w server
 *
 *  1. Фото со стопкой книг: распознавалась только одна (см. parsePhotoAnswer).
 *  2. Книга по ISBN не добавлялась: OpenLibrary не знает русских и польских
 *     изданий, Google Books без ключа отвечает 429 — нужен ещё источник и
 *     честный ответ человеку вместо молчания.
 *  3. «Уже есть N экземпляров в <город>» — общее число рядом с ОДНИМ городом,
 *     хотя экземпляры стоят в разных.
 */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `addbook-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { checkDuplicates, describeOthers } = await import('./publish.js')
const { parsePhotoAnswer, MAX_BOOKS_PER_PHOTO } = await import('./vision.js')
const { lookupIsbnDetailed, looksLikeIsbn, cleanBnAuthor, cleanBnTitle } = await import('./isbn.js')
const { buildSearch } = await import('./db.js')

/* ── 1. несколько книг на одном фото ─────────────────────── */

const answer = (books: unknown[], note = '') => JSON.stringify({ recognized: true, books, note })
const GENRES = ['Фантастика', 'Детектив']

test('фото стопки: в карточки идут ВСЕ распознанные книги, а не первая', () => {
  const r = parsePhotoAnswer(
    answer([
      { title: 'Дюна', author: 'Фрэнк Герберт', kind: 'book', languages: ['Русский'], genres: ['Фантастика'], confidence: 'high', spine: false },
      { title: 'Солярис', author: 'Станислав Лем', kind: 'book', languages: ['Polski'], genres: [], confidence: 'medium', spine: true },
      { title: 'Мастер и Маргарита', author: 'Михаил Булгаков', kind: 'book', languages: ['Русский'], genres: [], confidence: 'high', spine: true },
    ]),
    GENRES,
  )
  assert.equal(r?.books.length, 3)
  assert.deepEqual(r?.books.map((b) => b.title), ['Дюна', 'Солярис', 'Мастер и Маргарита'])
})

test('книга, видимая только корешком, помечена spine — по ней легче ошибиться', () => {
  const r = parsePhotoAnswer(
    answer([
      { title: 'Солярис', author: 'Лем', kind: 'book', languages: [], genres: [], confidence: 'medium', spine: true },
    ]),
    GENRES,
  )
  assert.equal(r?.books[0].spine, true)
})

test('одна книга, попавшая в ответ дважды (обложка и корешок), не задваивается', () => {
  const r = parsePhotoAnswer(
    answer([
      { title: 'Дюна', author: 'Фрэнк Герберт', kind: 'book', languages: [], genres: [], confidence: 'high', spine: false },
      { title: 'дюна', author: 'ФРЭНК ГЕРБЕРТ', kind: 'book', languages: [], genres: [], confidence: 'low', spine: true },
    ]),
    GENRES,
  )
  assert.equal(r?.books.length, 1)
})

test('нечитаемые корешки не превращаются в книги, а note доходит до человека', () => {
  const r = parsePhotoAnswer(
    answer(
      [
        { title: '', author: '', kind: 'book', languages: [], genres: [], confidence: 'low', spine: true },
        { title: 'В', author: '', kind: 'book', languages: [], genres: [], confidence: 'low', spine: true },
        { title: 'Дюна', author: null, kind: 'book', languages: [], genres: [], confidence: 'high', spine: false },
      ],
      'Три корешка справа не читаются',
    ),
    GENRES,
  )
  assert.deepEqual(r?.books.map((b) => b.title), ['Дюна'])
  assert.equal(r?.note, 'Три корешка справа не читаются')
})

test('жанры вне справочника отбрасываются, длинный список режется', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    title: `Книга ${i}`,
    author: null,
    kind: 'book',
    languages: ['Клингонский'],
    genres: ['Фантастика', 'Выдуманный жанр'],
    confidence: 'high',
    spine: false,
  }))
  const r = parsePhotoAnswer(answer(many), GENRES)
  assert.equal(r?.books.length, MAX_BOOKS_PER_PHOTO)
  assert.deepEqual(r?.books[0].genres, ['Фантастика'])
  assert.deepEqual(r?.books[0].languages, [])
})

test('не-JSON от модели не роняет добавление', () => {
  assert.equal(parsePhotoAnswer('извините, не смог', GENRES), null)
})

/* ── 2. поиск по ISBN ────────────────────────────────────── */

test('ISBN узнаётся с дефисами и пробелами, мусор отсеивается', () => {
  assert.equal(looksLikeIsbn('978-83-08-06368-2'), true)
  assert.equal(looksLikeIsbn('9785171147426'), true)
  assert.equal(looksLikeIsbn('0451450523'), true)
  assert.equal(looksLikeIsbn('12345'), false)
  assert.equal(looksLikeIsbn('Дюна — Фрэнк Герберт'), false)
})

test('каталожная запись польской библиотеки чистится до автора и названия', () => {
  assert.equal(
    cleanBnAuthor('Kalanithi, Paul (1977-2015) Verghese, Abraham (1955- ) Wydawnictwo Literackie'),
    'Paul Kalanithi',
  )
  assert.equal(cleanBnTitle('Jeszcze jeden oddech / When breath becomes air,'), 'Jeszcze jeden oddech')
  assert.equal(cleanBnAuthor(null), null)
})

/** Подменяем сеть: тесты не должны зависеть от живых каталогов. */
function withFetch(handler: (url: string, init?: any) => { status: number; body?: unknown }) {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    const { status, body } = handler(String(input), init)
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response
  }) as typeof fetch
  return () => {
    globalThis.fetch = real
  }
}

test('польское издание находится в каталоге Biblioteka Narodowa, когда OpenLibrary молчит', async () => {
  const restore = withFetch((url) => {
    if (url.includes('openlibrary.org/api/books')) return { status: 200, body: {} }
    if (url.includes('data.bn.org.pl'))
      return {
        status: 200,
        body: { bibs: [{ title: 'Solaris / Solaris,', author: 'Lem, Stanisław (1921-2006)' }] },
      }
    return { status: 404 }
  })
  try {
    const r = await lookupIsbnDetailed('9788308063682')
    assert.equal(r.book?.source, 'bn')
    assert.equal(r.book?.title, 'Solaris')
    assert.equal(r.book?.author, 'Stanisław Lem')
  } finally {
    restore()
  }
})

test('квота Google Books (429) видна в ответе — иначе жалоба «ISBN не работает» необъяснима', async () => {
  const restore = withFetch((url) => {
    if (url.includes('openlibrary.org/api/books')) return { status: 200, body: {} }
    if (url.includes('data.bn.org.pl')) return { status: 200, body: { bibs: [] } }
    if (url.includes('googleapis.com')) return { status: 429 }
    return { status: 404 }
  })
  try {
    const r = await lookupIsbnDetailed('9785171147426')
    assert.equal(r.book, null)
    assert.equal(r.notFound, true)
    assert.equal(r.quotaBlocked, true)
  } finally {
    restore()
  }
})

test('разовый 503 от Google Books не теряет книгу — запрос повторяется', async () => {
  let googleCalls = 0
  const restore = withFetch((url) => {
    if (url.includes('openlibrary.org/api/books')) return { status: 200, body: {} }
    if (url.includes('data.bn.org.pl')) return { status: 200, body: { bibs: [] } }
    if (url.includes('googleapis.com')) {
      googleCalls++
      // первый ответ — типичный backendFailed, второй нормальный
      return googleCalls === 1
        ? { status: 503 }
        : {
            status: 200,
            body: { items: [{ volumeInfo: { title: 'Дюна', authors: ['Фрэнк Герберт'] } }] },
          }
    }
    return { status: 404 }
  })
  try {
    const r = await lookupIsbnDetailed('9785171147426')
    assert.equal(googleCalls, 2, 'сбой сервера должен повторяться')
    assert.equal(r.book?.title, 'Дюна')
    assert.equal(r.book?.source, 'google')
  } finally {
    restore()
  }
})

test('429 (квота) не повторяем — это не сбой, а отказ по лимиту', async () => {
  let googleCalls = 0
  const restore = withFetch((url) => {
    if (url.includes('openlibrary.org/api/books')) return { status: 200, body: {} }
    if (url.includes('data.bn.org.pl')) return { status: 200, body: { bibs: [] } }
    if (url.includes('googleapis.com')) {
      googleCalls++
      return { status: 429 }
    }
    return { status: 404 }
  })
  try {
    const r = await lookupIsbnDetailed('9785171147426')
    assert.equal(googleCalls, 1)
    assert.equal(r.quotaBlocked, true)
  } finally {
    restore()
  }
})

test('обложка OpenLibrary без картинки (404 на HEAD) в каталог не записывается', async () => {
  const restore = withFetch((url, init) => {
    if (url.includes('openlibrary.org/api/books'))
      return { status: 200, body: { 'ISBN:9780441013593': { title: 'Dune', authors: [{ name: 'Frank Herbert' }] } } }
    if (url.includes('covers.openlibrary.org')) return { status: init?.method === 'HEAD' ? 404 : 404 }
    return { status: 404 }
  })
  try {
    const r = await lookupIsbnDetailed('9780441013593')
    assert.equal(r.book?.title, 'Dune')
    assert.equal(r.book?.coverUrl, null)
  } finally {
    restore()
  }
})

/* ── 3. «где и сколько» у чужих экземпляров ──────────────── */

async function seedCopy(o: { tgId: bigint; city: string | null; ownerCity?: string | null; title?: string }) {
  const title = o.title ?? 'Дюна'
  await prisma.user.upsert({ where: { tgId: o.tgId }, create: { tgId: o.tgId }, update: {} })
  const lib = await prisma.librarian.create({
    data: { name: `L${o.tgId}`, tgId: o.tgId, city: o.ownerCity ?? null },
  })
  await prisma.book.create({
    data: {
      title,
      author: 'Фрэнк Герберт',
      city: o.city,
      ownerId: lib.id,
      source: 'bot',
      search: buildSearch({ title, author: 'Фрэнк Герберт', city: o.city }),
    },
  })
  return lib
}

beforeEach(async () => {
  await prisma.book.deleteMany()
  await prisma.librarian.deleteMany()
  await prisma.user.deleteMany()
})

test('экземпляры в разных городах перечисляются по городам, а не «все в одном»', async () => {
  await seedCopy({ tgId: 1n, city: 'Warszawa' })
  await seedCopy({ tgId: 2n, city: 'Warszawa' })
  await seedCopy({ tgId: 3n, city: 'Kraków' })

  const dup = await checkDuplicates({ title: 'Дюна', author: 'Фрэнк Герберт', kind: 'book' })
  assert.equal(dup.others.count, 3)
  assert.deepEqual(dup.others.byCity, [
    { city: 'Warszawa', count: 2 },
    { city: 'Kraków', count: 1 },
  ])
  assert.equal(dup.others.where, '2 в Warszawa, 1 в Kraków')
})

test('город берётся у владельца, если у книги он не заполнен (частый случай из Notion)', async () => {
  await seedCopy({ tgId: 1n, city: null, ownerCity: 'Poznań' })
  const dup = await checkDuplicates({ title: 'Дюна', author: 'Фрэнк Герберт', kind: 'book' })
  assert.equal(dup.others.where, '1 в Poznań')
  assert.equal(dup.others.unknownCity, 0)
})

test('экземпляр совсем без города считается, но городом не притворяется', async () => {
  await seedCopy({ tgId: 1n, city: 'Warszawa' })
  await seedCopy({ tgId: 2n, city: null, ownerCity: null })
  const dup = await checkDuplicates({ title: 'Дюна', author: 'Фрэнк Герберт', kind: 'book' })
  assert.equal(dup.others.count, 2)
  assert.equal(dup.others.where, '1 в Warszawa, 1 без города')
})

test('своя книга не попадает в чужие экземпляры', async () => {
  await seedCopy({ tgId: 7n, city: 'Warszawa' })
  await seedCopy({ tgId: 8n, city: 'Kraków' })
  const dup = await checkDuplicates({
    title: 'Дюна',
    author: 'Фрэнк Герберт',
    kind: 'book',
    ownerTg: 7n,
  })
  assert.ok(dup.own, 'свой экземпляр должен найтись')
  assert.equal(dup.others.count, 1)
  assert.equal(dup.others.where, '1 в Kraków')
})

test('городов больше трёх — хвост сворачивается, но число сходится с общим', async () => {
  const cities = ['Warszawa', 'Kraków', 'Poznań', 'Wrocław', 'Łódź']
  for (const [i, city] of cities.entries()) await seedCopy({ tgId: BigInt(i + 1), city })
  const dup = await checkDuplicates({ title: 'Дюна', author: 'Фрэнк Герберт', kind: 'book' })
  assert.equal(dup.others.count, 5)
  assert.equal(dup.others.byCity.length, 5)
  assert.match(dup.others.where, /2 в других городах$/)
})

test('describeOthers ничего не выдумывает, когда экземпляров нет', () => {
  assert.equal(describeOthers({ count: 0, city: null, byCity: [], unknownCity: 0 }), '')
})

after(async () => {
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})
