import { Prisma } from '@prisma/client'
import { norm, prisma } from './db.js'

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
    coverUrl: b.coverUrl,
    status: b.status,
    source: b.source,
    owner: b.owner ?? null,
  }
}

function whereOf(p: SearchParams): Prisma.BookWhereInput {
  const and: Prisma.BookWhereInput[] = [{ active: true }]
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

export async function searchBooks(p: SearchParams) {
  const limit = Math.min(p.limit ?? 30, 100)
  const where = whereOf(p)
  const [total, rows] = await Promise.all([
    prisma.book.count({ where }),
    prisma.book.findMany({
      where,
      include: { owner: OWNER_SELECT },
      orderBy: [{ addedAt: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      skip: p.offset ?? 0,
    }),
  ])

  // подтягиваем точные совпадения по названию наверх — дешевле, чем FTS,
  // и на 3000 книг незаметно
  const q = norm(p.q || '')
  const scored = q
    ? rows
        .map((b) => {
          const title = norm(b.title)
          const author = norm(b.author || '')
          let score = 0
          if (title === q) score += 100
          if (title.startsWith(q)) score += 50
          if (title.includes(q)) score += 25
          if (author.includes(q)) score += 15
          return { b, score }
        })
        .sort((x, y) => y.score - x.score)
        .map((x) => x.b)
    : rows

  return { total, items: scored.map(toCard) }
}

export async function bookById(id: string) {
  const b = await prisma.book.findFirst({
    where: { id, active: true },
    include: { owner: OWNER_SELECT },
  })
  return b ? toCard(b) : null
}

export async function facets(city?: string) {
  const where: Prisma.BookWhereInput = { active: true, ...(city ? { city } : {}) }
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
