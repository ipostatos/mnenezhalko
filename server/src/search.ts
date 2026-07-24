import { Prisma } from '@prisma/client'
import { norm, prisma } from './db.js'
import { proxyCover } from './imgcache.js'

export type SearchParams = {
  q?: string
  city?: string
  kind?: 'book' | 'game'
  genre?: string
  language?: string
  ownerId?: string
  limit?: number
  offset?: number
}

export type BookCard = {
  id: string
  kind: string
  title: string
  author: string | null
  genres: string[]
  languages: string[]
  city: string | null
  district: string | null
  coverUrl: string | null
  status: string
  source: string
  /** состояние модерации: pending | approved | rejected | deleted */
  reviewStatus: string
  rejectionReason: string | null
  /** путь в Notion: local | pending | synced | failed */
  notionStatus: string
  owner: {
    id: string
    name: string
    telegram: string | null
    instagram: string | null
    city: string | null
    district: string | null
  } | null
}

const OWNER_SELECT = {
  select: {
    id: true,
    name: true,
    telegram: true,
    instagram: true,
    city: true,
    district: true,
  },
} as const

const split = (s: string | null | undefined) =>
  (s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

export function toCard(b: any): BookCard {
  return {
    id: b.id,
    kind: b.kind,
    title: b.title,
    author: b.author,
    genres: split(b.genres),
    languages: split(b.languages),
    city: b.city,
    district: b.district,
    coverUrl: proxyCover(b.coverUrl),
    status: b.status,
    source: b.source,
    reviewStatus: b.reviewStatus ?? 'approved',
    rejectionReason: b.rejectionReason ?? null,
    notionStatus: b.notionStatus ?? 'local',
    owner: b.owner ?? null,
  }
}

function whereOf(p: SearchParams): Prisma.BookWhereInput {
  // в каталог попадают только одобренные (без модерации все книги одобрены по дефолту)
  const and: Prisma.BookWhereInput[] = [{ active: true, reviewStatus: 'approved' }]
  if (p.kind) and.push({ kind: p.kind })
  if (p.city) and.push({ city: p.city })
  if (p.ownerId) and.push({ ownerId: p.ownerId })
  if (p.genre) and.push({ genres: { contains: p.genre } })
  if (p.language) and.push({ languages: { contains: p.language } })
  for (const token of norm(p.q || '').split(' ').filter(Boolean)) {
    and.push({ search: { contains: token } })
  }
  return { AND: and }
}

/**
 * Сколько совпадений подтягиваем, чтобы ранжировать их целиком.
 * На библиотеке в 3000+ книг ни один осмысленный запрос столько не находит,
 * так что практически это «все совпадения», а потолок — защита от `q` из одной
 * буквы, под которую подходит половина базы.
 */
const SCORE_WINDOW = 500

const relevance = (b: { title: string; author: string | null }, q: string) => {
  const title = norm(b.title)
  const author = norm(b.author || '')
  let score = 0
  if (title === q) score += 100
  if (title.startsWith(q)) score += 50
  if (title.includes(q)) score += 25
  if (author.includes(q)) score += 15
  return score
}

export async function searchBooks(p: SearchParams) {
  const limit = Math.min(p.limit ?? 30, 100)
  const offset = p.offset ?? 0
  const where = whereOf(p)
  const q = norm(p.q || '')

  // без текстового запроса сортировка задаётся базой — берём ровно страницу
  if (!q) {
    const [total, rows] = await Promise.all([
      prisma.book.count({ where }),
      prisma.book.findMany({
        where,
        include: { owner: OWNER_SELECT },
        orderBy: [{ addedAt: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        skip: offset,
      }),
    ])
    return { total, items: rows.map(toCard) }
  }

  // с запросом ранжируем весь набор совпадений и только потом режем на страницы:
  // иначе точное совпадение, попавшее по дате на вторую страницу, не всплывёт
  const [total, rows] = await Promise.all([
    prisma.book.count({ where }),
    prisma.book.findMany({
      where,
      include: { owner: OWNER_SELECT },
      orderBy: [{ addedAt: 'desc' }, { createdAt: 'desc' }],
      take: SCORE_WINDOW,
    }),
  ])

  const items = rows
    .map((b) => ({ b, score: relevance(b, q) }))
    .sort((x, y) => y.score - x.score)
    .slice(offset, offset + limit)
    .map((x) => toCard(x.b))

  return { total, items }
}

export async function bookById(id: string) {
  const b = await prisma.book.findFirst({
    where: { id, active: true, reviewStatus: 'approved' },
    include: { owner: OWNER_SELECT },
  })
  return b ? toCard(b) : null
}

/**
 * Справочники читаются целиком по всей библиотеке, а спрашивают их часто:
 * фильтры Mini App, каждый запрос к ИИ-помощнику, каждое распознавание фото.
 * Держим готовый ответ до правки библиотеки (синк, новая книга на полке).
 */
type Facets = Awaited<ReturnType<typeof computeFacets>>
const facetsCache = new Map<string, Facets>()

/** Библиотека изменилась — справочники пересчитаем при следующем запросе. */
export const invalidateFacets = () => facetsCache.clear()

export async function facets(city?: string) {
  const key = city ?? '*'
  const hit = facetsCache.get(key)
  if (hit) return hit
  const fresh = await computeFacets(city)
  facetsCache.set(key, fresh)
  return fresh
}

async function computeFacets(city?: string) {
  const where: Prisma.BookWhereInput = {
    active: true,
    reviewStatus: 'approved',
    ...(city ? { city } : {}),
  }
  const rows = await prisma.book.findMany({
    where,
    select: { genres: true, languages: true, city: true, kind: true },
  })
  const count = (vals: string[], acc: Map<string, number>) => {
    for (const v of vals) acc.set(v, (acc.get(v) || 0) + 1)
  }
  const genres = new Map<string, number>()
  const languages = new Map<string, number>()
  const cities = new Map<string, number>()
  for (const r of rows) {
    count(split(r.genres), genres)
    count(split(r.languages), languages)
    if (r.city) count([r.city], cities)
  }
  const top = (m: Map<string, number>, n = 40) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, count]) => ({ value, count }))
  return {
    total: rows.length,
    genres: top(genres),
    languages: top(languages, 15),
    cities: top(cities, 30),
  }
}
