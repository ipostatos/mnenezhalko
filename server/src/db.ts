import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()

/** Нормализация строки для поиска: нижний регистр, ё→е, схлопнутые пробелы. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'`’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Строка, по которой ищем книгу: название + автор + жанры + язык + город. */
export function buildSearch(b: {
  title: string
  author?: string | null
  genres?: string | null
  languages?: string | null
  city?: string | null
  district?: string | null
}): string {
  return norm(
    [b.title, b.author, b.genres, b.languages, b.city, b.district]
      .filter(Boolean)
      .join(' '),
  )
}
