/**
 * Поиск книги по ISBN.
 *
 * Почему источников несколько: OpenLibrary знает почти только англоязычные
 * издания (проверено 27 июля 2026: русские и польские ISBN отдают `{}`), а
 * Google Books без ключа отвечает 429 — общая анонимная квота выбирается чужими
 * запросами задолго до нас. Поэтому порядок такой:
 *   1) OpenLibrary        — быстрый, отдаёт авторов именами и обложку;
 *   2) Biblioteka Narodowa — польские издания, без ключа (data.bn.org.pl);
 *   3) Google Books        — шире всех по русским изданиям, но полезен только
 *                            с ключом GOOGLE_BOOKS_KEY.
 * Первый источник, который ответил осмысленно, выигрывает.
 */
import { env } from './env.js'

export type IsbnSource = 'openlibrary' | 'bn' | 'google'

export type IsbnBook = {
  title: string
  author: string | null
  coverUrl: string | null
  source: IsbnSource
}

/** Итог поиска: книга либо причина, по которой её нет (для честного ответа человеку). */
export type IsbnLookup = {
  book: IsbnBook | null
  /** ни один источник не знает этот ISBN */
  notFound: boolean
  /** Google Books ответил 429 — то есть без ключа мы к нему фактически не ходим */
  quotaBlocked: boolean
}

const onlyIsbn = (s: string) => s.replace(/[^0-9Xx]/g, '').toUpperCase()

/** Похоже ли на ISBN-10/13 (после выкидывания дефисов/пробелов). */
export function looksLikeIsbn(s: string): boolean {
  const d = onlyIsbn(s)
  return (d.length === 10 || d.length === 13) && /^\d{9}[\dX]$|^\d{13}$/.test(d)
}

const TIMEOUT_MS = 8_000

/** Внешние справочники не должны подвешивать добавление книги. */
async function getJson(url: string): Promise<{ ok: boolean; status: number; body: any }> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, { signal: ctl.signal })
    const body = r.ok ? await r.json() : null
    return { ok: r.ok, status: r.status, body }
  } catch {
    return { ok: false, status: 0, body: null }
  } finally {
    clearTimeout(t)
  }
}

/**
 * Обложка OpenLibrary по ISBN есть далеко не всегда, а `?default=false` отдаёт
 * 404 — ссылку без проверки нельзя записывать в каталог, иначе у книги будет
 * битая картинка. Проверяем HEAD-запросом.
 */
async function openLibraryCover(isbn: string): Promise<string | null> {
  const url = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, { method: 'HEAD', signal: ctl.signal })
    return r.ok ? url : null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function fromOpenLibrary(isbn: string): Promise<IsbnBook | null> {
  const { ok, body } = await getJson(
    `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`,
  )
  if (!ok) return null
  const b = body?.[`ISBN:${isbn}`]
  if (!b?.title) return null
  const authors: string[] = Array.isArray(b.authors)
    ? b.authors.map((a: any) => a?.name).filter(Boolean)
    : []
  return {
    title: String(b.title).slice(0, 300),
    author: authors.length ? authors.join(', ').slice(0, 200) : null,
    coverUrl: b.cover?.large || b.cover?.medium || (await openLibraryCover(isbn)),
    source: 'openlibrary',
  }
}

/**
 * Каталог Национальной библиотеки Польши отдаёт данные каталожной карточки, а не
 * карточки магазина: в `author` через пробел склеены автор, переводчик и издатель
 * («Kalanithi, Paul (1977-2015) Małecki, Łukasz Wydawnictwo Literackie»), а в
 * `title` — второе название после « / ». Приводим к человеческому виду.
 */
export function cleanBnAuthor(raw: string | null | undefined): string | null {
  if (!raw) return null
  // первый автор — до закрывающей скобки с годами жизни
  const first = raw.includes(')') ? raw.slice(0, raw.indexOf(')')) : raw
  const noYears = first.replace(/\([^)]*$/, '').replace(/\(.*?\)/g, '').trim()
  if (!noYears) return null
  // каталожный формат «Фамилия, Имя» разворачиваем в «Имя Фамилия»
  const parts = noYears.split(',').map((s) => s.trim()).filter(Boolean)
  const name = parts.length === 2 ? `${parts[1]} ${parts[0]}` : parts.join(' ')
  return name.slice(0, 200) || null
}

export function cleanBnTitle(raw: string): string {
  return raw
    .split(' / ')[0]
    .replace(/\s*[;:,.]\s*$/, '')
    .trim()
    .slice(0, 300)
}

async function fromBibliotekaNarodowa(isbn: string): Promise<IsbnBook | null> {
  const { ok, body } = await getJson(
    `https://data.bn.org.pl/api/bibs.json?isbnIssn=${isbn}&limit=1`,
  )
  if (!ok) return null
  const b = Array.isArray(body?.bibs) ? body.bibs[0] : null
  if (!b?.title) return null
  const title = cleanBnTitle(String(b.title))
  if (!title) return null
  return {
    title,
    author: cleanBnAuthor(b.author),
    coverUrl: await openLibraryCover(isbn),
    source: 'bn',
  }
}

async function fromGoogleBooks(
  isbn: string,
): Promise<{ book: IsbnBook | null; quotaBlocked: boolean }> {
  const key = env.googleBooksKey
  const url =
    `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}` + (key ? `&key=${key}` : '')
  const { ok, status, body } = await getJson(url)
  if (!ok) return { book: null, quotaBlocked: status === 429 }
  const v = body?.items?.[0]?.volumeInfo
  if (!v?.title) return { book: null, quotaBlocked: false }
  const cover: string | undefined = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail
  return {
    book: {
      title: String(v.title).slice(0, 300),
      author: Array.isArray(v.authors) && v.authors.length ? v.authors.join(', ') : null,
      // Google отдаёт http и уменьшенную картинку — просим https и покрупнее
      coverUrl: cover ? cover.replace(/^http:/, 'https:').replace(/&zoom=\d/, '&zoom=1') : null,
      source: 'google',
    },
    quotaBlocked: false,
  }
}

/** Полный поиск с причиной неудачи. */
export async function lookupIsbnDetailed(raw: string): Promise<IsbnLookup> {
  const isbn = onlyIsbn(raw)
  if (isbn.length !== 10 && isbn.length !== 13) {
    return { book: null, notFound: true, quotaBlocked: false }
  }

  const ol = await fromOpenLibrary(isbn)
  if (ol) return { book: ol, notFound: false, quotaBlocked: false }

  const bn = await fromBibliotekaNarodowa(isbn)
  if (bn) return { book: bn, notFound: false, quotaBlocked: false }

  const g = await fromGoogleBooks(isbn)
  if (g.book) return { book: g.book, notFound: false, quotaBlocked: false }

  return { book: null, notFound: true, quotaBlocked: g.quotaBlocked }
}

export async function lookupIsbn(raw: string): Promise<IsbnBook | null> {
  return (await lookupIsbnDetailed(raw)).book
}
