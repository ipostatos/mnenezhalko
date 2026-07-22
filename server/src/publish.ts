/**
 * «Поставить книгу на полку» целиком — как этого требует инструкция новичка:
 *   1) библиотекарь заводится в таблице Owners (если его там ещё нет);
 *   2) книга уходит строкой в All Books, настолка — в Board Games;
 *   3) параллельно карточка живёт у нас, чтобы поиск и бот видели её сразу.
 *
 * Если запись в Notion выключена (нет NOTION_TOKEN_V2) или отвалилась, карточка
 * остаётся со статусом `pending`/`failed` и уходит в общую таблицу позже —
 * ручным «дожимом» или автоматически перед очередным синком.
 */
import { prisma, buildSearch } from './db.js'
import { isAdmin } from './env.js'
import { toCard, searchBooks, invalidateFacets, type BookCard } from './search.js'
import { createBook, createOwner, notionWriteEnabled } from './notion-write.js'

export type ShelfDraft = {
  tgId: bigint
  username?: string | null
  firstName?: string | null
  kind: 'book' | 'game'
  title: string
  author?: string | null
  genres?: string[]
  languages?: string[]
  city?: string | null
  district?: string | null
  coverUrl?: string | null
}

export type ShelfResult = {
  book: BookCard
  notionStatus: string
  notionError: string | null
}

/** Уведомление админам о карточке, которую не удалось положить в Notion. */
type PendingNotifier = (book: BookCard, reason: string) => void | Promise<void>
let notifier: PendingNotifier | null = null
export const setPendingNotifier = (fn: PendingNotifier) => {
  notifier = fn
}

const cityDistrictOf = (city?: string | null, district?: string | null) =>
  city ? (district ? `${city}/${district}` : city) : null

export async function putOnShelf(d: ShelfDraft): Promise<ShelfResult> {
  const user = await prisma.user.upsert({
    where: { tgId: d.tgId },
    create: {
      tgId: d.tgId,
      username: d.username ?? null,
      firstName: d.firstName ?? null,
      city: d.city ?? null,
      isAdmin: isAdmin(d.tgId),
    },
    update: { username: d.username ?? undefined, city: d.city ?? undefined },
  })

  // 1. библиотекарь у нас
  let librarian = await prisma.librarian.findUnique({ where: { tgId: d.tgId } })
  if (!librarian) {
    librarian = await prisma.librarian.create({
      data: {
        name: d.firstName || d.username || 'Библиотекарь',
        telegram: d.username ?? null,
        city: d.city ?? user.city ?? null,
        district: d.district ?? null,
        tgId: d.tgId,
      },
    })
  } else if ((d.city && !librarian.city) || (d.district && !librarian.district)) {
    librarian = await prisma.librarian.update({
      where: { id: librarian.id },
      data: {
        city: librarian.city ?? d.city ?? null,
        district: librarian.district ?? d.district ?? null,
      },
    })
  }

  // 2. библиотекарь в Owners
  let notionError: string | null = null
  if (notionWriteEnabled() && !librarian.notionId) {
    try {
      const notionId = await createOwner({
        name: librarian.name,
        telegram: librarian.telegram,
        instagram: librarian.instagram,
        cityDistrict: cityDistrictOf(librarian.city, librarian.district),
      })
      librarian = await prisma.librarian.update({
        where: { id: librarian.id },
        data: { notionId },
      })
    } catch (e: any) {
      notionError = `Owners: ${e?.message ?? e}`
      console.error('[notion] не удалось завести библиотекаря:', notionError)
    }
  }

  // 3. карточка у нас — всегда, чтобы поиск видел её сразу
  const city = d.city ?? librarian.city ?? null
  const district = d.district ?? librarian.district ?? null
  const data = {
    kind: d.kind,
    title: d.title.trim().slice(0, 300),
    author: d.author?.trim().slice(0, 200) || null,
    genres: (d.genres ?? []).join(', ').slice(0, 300),
    languages: (d.languages ?? []).join(', ').slice(0, 200),
    city,
    district,
    coverUrl: d.coverUrl?.slice(0, 1000) || null,
    source: 'bot',
    addedByTg: d.tgId,
    addedAt: new Date(),
    ownerId: librarian.id,
    notionStatus: 'pending',
  }
  let book = await prisma.book.create({
    data: { ...data, search: buildSearch(data) },
  })
  invalidateFacets()

  // 4. строка в общей таблице
  const pushed = await pushToNotion(book.id, notionError)
  book = pushed.book

  const card = toCard({ ...book, owner: librarian })
  if (book.notionStatus !== 'synced') {
    await Promise.resolve(
      notifier?.(card, book.notionError ?? 'запись в Notion выключена'),
    ).catch(() => {})
  }
  return { book: card, notionStatus: book.notionStatus, notionError: book.notionError }
}

/** Одна попытка положить уже созданную карточку в общую таблицу. */
async function pushToNotion(bookId: string, previousError: string | null = null) {
  const book = await prisma.book.findUniqueOrThrow({
    where: { id: bookId },
    include: { owner: true },
  })

  if (!notionWriteEnabled()) {
    return {
      book: await prisma.book.update({
        where: { id: bookId },
        data: { notionStatus: 'pending', notionError: previousError },
      }),
    }
  }

  try {
    const notionId = await createBook({
      kind: book.kind === 'game' ? 'game' : 'book',
      title: book.title,
      author: book.author,
      genres: book.genres ? book.genres.split(',').map((s) => s.trim()).filter(Boolean) : [],
      languages: book.languages
        ? book.languages.split(',').map((s) => s.trim()).filter(Boolean)
        : [],
      coverUrl: book.coverUrl,
      ownerNotionId: book.owner?.notionId ?? null,
      cityDistrict: cityDistrictOf(book.city, book.district),
    })
    return {
      book: await prisma.book.update({
        where: { id: bookId },
        data: { notionId, notionStatus: 'synced', notionError: null },
      }),
    }
  } catch (e: any) {
    const message = `${previousError ? previousError + '; ' : ''}${e?.message ?? e}`.slice(0, 500)
    console.error('[notion] книга не ушла в общую таблицу:', message)
    return {
      book: await prisma.book.update({
        where: { id: bookId },
        data: { notionStatus: 'failed', notionError: message },
      }),
    }
  }
}

/**
 * Дожимает всё, что не уехало в Notion (нет токена, сбой сети, 401).
 * Вызывается перед плановым синком и админской командой `/notionpush`.
 */
export async function flushPending(limit = 50): Promise<{ ok: number; failed: number }> {
  if (!notionWriteEnabled()) return { ok: 0, failed: 0 }
  const rows = await prisma.book.findMany({
    where: { source: 'bot', notionId: null, notionStatus: { in: ['pending', 'failed'] } },
    select: { id: true },
    take: limit,
  })
  let ok = 0
  let failed = 0
  for (const r of rows) {
    const { book } = await pushToNotion(r.id)
    book.notionStatus === 'synced' ? ok++ : failed++
  }
  return { ok, failed }
}

export const pendingCount = () =>
  prisma.book.count({
    where: { source: 'bot', notionId: null, notionStatus: { in: ['pending', 'failed'] } },
  })

/**
 * Лайфхак из инструкции: та же книга уже может быть у кого-то —
 * показываем совпадения до сохранения.
 */
export async function findDuplicates(title: string, author?: string | null) {
  const q = title.trim()
  if (q.length < 3) return []
  const { items } = await searchBooks({ q, limit: 5 })
  const a = (author || '').trim().toLowerCase()
  return items
    .filter((b) => b.title.toLowerCase().includes(q.toLowerCase()) || (a && (b.author || '').toLowerCase().includes(a)))
    .slice(0, 3)
}
