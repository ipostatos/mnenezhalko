/**
 * Оценки и короткие аннотации к книгам (issue #18).
 *
 * Три решения, которые здесь важнее кода:
 *
 * 1. **Оценка вешается на произведение, а не на экземпляр.** У одной книги в
 *    каталоге по карточке на каждого библиотекаря: при привязке к `Book.id` у
 *    трёх экземпляров «Мастера и Маргариты» вышло бы три рейтинга по одной
 *    оценке. Ключ — `workKey` (нормализованные название и автор).
 * 2. **Оценивают только читавшие.** Право даёт закрытая выдача этой книги на
 *    человека либо собственный экземпляр на полке. Иначе рейтинг перестаёт
 *    значить «проверено нашими» и превращается в накрутку.
 * 3. **Агрегат считается в одной транзакции с отзывом** (`WorkRating`): иначе
 *    страница каталога из 40 книг стоила бы 40 агрегирующих запросов.
 *
 * Функции не знают о Fastify и grammY: на входе данные, на выходе данные —
 * поэтому проверяются тестами без сети (reviews.test.ts).
 */
import type { Prisma } from '@prisma/client'
import { norm, prisma } from './db.js'

/** Аннотация — пара предложений, а не рецензия: столько влезает в карточку. */
export const REVIEW_TEXT_MAX = 300

/** Сколько жалоб скрывают отзыв до решения администратора. */
export const REPORTS_TO_HIDE = 3

export type ReviewInput = { rating: unknown; text?: unknown }

/**
 * Ключ произведения: название + автор, оба нормализованы (нижний регистр, ё→е,
 * схлопнутые пробелы — та же `norm`, что и в поиске).
 *
 * Автор входит в ключ намеренно: «Дом» Данилевского и «Дом» Стародубцева —
 * разные книги. Обратная сторона: у книги, добавленной без автора, ключ свой,
 * и её оценки не сольются с тем же изданием, где автор указан. Это честнее
 * обратного: смешать чужие оценки хуже, чем показать их отдельно.
 */
export function workKeyOf(b: { title: string; author?: string | null }): string {
  return `${norm(b.title)}|${norm(b.author || '')}`
}

/** Ссылки в публичном тексте — главный спам-вектор, поэтому запрещены. */
const LINK_RE = /(https?:\/\/|www\.|t\.me\/|\b[a-z0-9-]+\.(ru|com|net|org|pl|by|io)\b)/i

/**
 * Проверка того, что прислал клиент. Бросает осмысленную ошибку — ручка
 * превращает её в 400 с тем же кодом, бот в человеческий текст.
 */
export function validateReview(input: ReviewInput): { rating: number; text: string | null } {
  const rating = Number(input.rating)
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('bad_rating')

  const raw = input.text === undefined || input.text === null ? '' : String(input.text)
  const text = raw.trim().replace(/\s+/g, ' ')
  if (text.length > REVIEW_TEXT_MAX) throw new Error('text_too_long')
  if (text && LINK_RE.test(text)) throw new Error('links_not_allowed')
  return { rating, text: text || null }
}

/**
 * Читал ли человек эту книгу: закрытая выдача на него либо свой экземпляр.
 *
 * Выдачи без карточки книги (владелец записал просто название) тоже считаются:
 * ключ тогда строится по названию выдачи. Автора в такой записи нет, поэтому
 * право появится на карточках, у которых автор тоже пуст.
 */
export async function canReview(tgId: bigint, workKey: string): Promise<boolean> {
  const loans = await prisma.loan.findMany({
    where: { holderTg: tgId, status: 'returned' },
    select: { title: true, book: { select: { title: true, author: true } } },
    orderBy: { returnedAt: 'desc' },
    take: 200,
  })
  for (const l of loans) {
    const key = l.book ? workKeyOf(l.book) : workKeyOf({ title: l.title })
    if (key === workKey) return true
  }

  const librarian = await prisma.librarian.findUnique({ where: { tgId }, select: { id: true } })
  if (!librarian) return false
  const own = await prisma.book.findMany({
    where: { ownerId: librarian.id, active: true },
    select: { title: true, author: true },
    take: 500,
  })
  return own.some((b) => workKeyOf(b) === workKey)
}

/**
 * Пересчёт агрегата по произведению внутри той же транзакции, что и правка
 * отзыва. Считаем только видимые: скрытый по жалобам отзыв не должен и дальше
 * тянуть среднюю вниз (или вверх).
 */
async function recountWork(tx: Prisma.TransactionClient, workKey: string) {
  const rows = await tx.review.findMany({
    where: { workKey, status: 'visible' },
    select: { rating: true },
  })
  const count = rows.length
  const sum = rows.reduce((acc, r) => acc + r.rating, 0)
  if (!count) {
    await tx.workRating.deleteMany({ where: { workKey } })
    return { count: 0, sum: 0 }
  }
  await tx.workRating.upsert({
    where: { workKey },
    create: { workKey, count, sum },
    update: { count, sum },
  })
  return { count, sum }
}

export type ReviewBook = { id?: string | null; title: string; author?: string | null }

/**
 * Поставить или обновить свою оценку. Повторный вызов правит существующий
 * отзыв (уникальность workKey+автор гарантирует база), а не заводит второй.
 */
export async function upsertReview(opts: {
  authorTg: bigint
  book: ReviewBook
  rating: number
  text: string | null
}) {
  const workKey = workKeyOf(opts.book)
  return prisma.$transaction(async (tx) => {
    const review = await tx.review.upsert({
      where: { workKey_authorTg: { workKey, authorTg: opts.authorTg } },
      create: {
        workKey,
        bookId: opts.book.id ?? null,
        authorTg: opts.authorTg,
        rating: opts.rating,
        text: opts.text,
      },
      // правка своего отзыва снимает накопленные жалобы и скрытие: это уже
      // другой текст, судить его прежними жалобами нечестно
      update: {
        rating: opts.rating,
        text: opts.text,
        status: 'visible',
        reports: 0,
        hiddenAt: null,
        hiddenByTg: null,
      },
    })
    const agg = await recountWork(tx, workKey)
    return { review, rating: toAverage(agg) }
  })
}

/** Удалить свой отзыв. Возвращает false, если его и не было. */
export async function deleteReview(authorTg: bigint, workKey: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.review.findUnique({
      where: { workKey_authorTg: { workKey, authorTg } },
      select: { id: true },
    })
    if (!existing) return { deleted: false, rating: { avg: null, count: 0 } }
    await tx.review.delete({ where: { id: existing.id } })
    const agg = await recountWork(tx, workKey)
    return { deleted: true, rating: toAverage(agg) }
  })
}

/**
 * Пожаловаться на чужой отзыв. Постмодерация: до решения администратора текст
 * прячется сам, набрав REPORTS_TO_HIDE жалоб. На свой отзыв жаловаться нельзя,
 * повторная жалоба того же человека не считается.
 */
export async function reportReview(id: string, byTg: bigint) {
  return prisma.$transaction(async (tx) => {
    const review = await tx.review.findUnique({ where: { id } })
    if (!review) return { error: 'not_found' as const }
    if (review.authorTg === byTg) return { error: 'own_review' as const }
    if (review.status !== 'visible') return { hidden: true, reports: review.reports }

    const reports = review.reports + 1
    const hide = reports >= REPORTS_TO_HIDE
    await tx.review.update({
      where: { id },
      data: {
        reports,
        ...(hide ? { status: 'hidden', hiddenAt: new Date() } : {}),
      },
    })
    if (hide) await recountWork(tx, review.workKey)
    return { hidden: hide, reports }
  })
}

const toAverage = (agg: { count: number; sum: number }) => ({
  avg: agg.count ? Math.round((agg.sum / agg.count) * 10) / 10 : null,
  count: agg.count,
})

export type PublicReview = {
  id: string
  rating: number
  text: string | null
  /** имя автора отзыва: только firstName, без ника и без tgId (см. privacy.ts) */
  authorName: string
  mine: boolean
  createdAt: Date
}

/**
 * Отзывы о произведении для показа всем.
 *
 * Наружу уходит только имя: ник и числовой tgId — контакты, их правила описаны
 * в privacy.ts, и отзыв не повод их раскрывать. Свой отзыв поднимается наверх,
 * чтобы человек сразу видел, что уже написал.
 */
export async function listReviews(
  workKey: string,
  viewerTg?: bigint | null,
  limit = 50,
): Promise<PublicReview[]> {
  const rows = await prisma.review.findMany({
    where: { workKey, status: 'visible' },
    include: { author: { select: { firstName: true } } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  const items = rows.map((r) => ({
    id: r.id,
    rating: r.rating,
    text: r.text,
    authorName: r.author?.firstName?.trim() || 'Читатель',
    mine: viewerTg !== undefined && viewerTg !== null && r.authorTg === viewerTg,
    createdAt: r.createdAt,
  }))
  return items.sort((a, b) => Number(b.mine) - Number(a.mine))
}

export type Rating = { avg: number | null; count: number }

/** Средняя и число оценок по одному произведению. */
export async function ratingFor(workKey: string): Promise<Rating> {
  const row = await prisma.workRating.findUnique({ where: { workKey } })
  return row ? toAverage(row) : { avg: null, count: 0 }
}

/**
 * Рейтинги пачкой — для списка каталога: одна выборка на страницу вместо
 * запроса на каждую книгу.
 */
export async function ratingsFor(books: { title: string; author?: string | null }[]) {
  const keys = [...new Set(books.map(workKeyOf))]
  if (!keys.length) return new Map<string, Rating>()
  const rows = await prisma.workRating.findMany({ where: { workKey: { in: keys } } })
  return new Map(rows.map((r) => [r.workKey, toAverage(r)]))
}
