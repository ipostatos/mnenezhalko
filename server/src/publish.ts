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
import type { Librarian } from '@prisma/client'
import { prisma, buildSearch, norm } from './db.js'
import { env, isAdmin } from './env.js'
import { toCard, searchBooks, invalidateFacets, type BookCard } from './search.js'
import { archiveRow, createBook, createOwner, notionWriteEnabled, updateBook } from './notion-write.js'
import { linkLibrarian } from './librarian.js'

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

/** Карточка ушла на модерацию — показываем админам с кнопками одобрить/отклонить. */
type ModerationNotifier = (book: BookCard, owner: Librarian) => void | Promise<void>
let moderationNotifier: ModerationNotifier | null = null
export const setModerationNotifier = (fn: ModerationNotifier) => {
  moderationNotifier = fn
}

const cityDistrictOf = (city?: string | null, district?: string | null) =>
  city ? (district ? `${city}/${district}` : city) : null

/**
 * Заводит владельца в Owners (если ещё нет) и льёт книгу в общую таблицу.
 * Общий путь для мгновенного добавления и для одобрения после модерации.
 */
async function sendBookToNotion(bookId: string, librarian: Librarian) {
  let notionError: string | null = null
  if (notionWriteEnabled() && !librarian.notionId) {
    try {
      const notionId = await createOwner({
        name: librarian.name,
        telegram: librarian.telegram,
        instagram: librarian.instagram,
        cityDistrict: cityDistrictOf(librarian.city, librarian.district),
      })
      await prisma.librarian.update({ where: { id: librarian.id }, data: { notionId } })
    } catch (e: any) {
      notionError = `Owners: ${e?.message ?? e}`
      console.error('[notion] не удалось завести библиотекаря:', notionError)
    }
  }
  return (await pushToNotion(bookId, notionError)).book
}

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

  // библиотекарь у нас — единая идентификация: по tgId, затем по нику, затем создание
  const librarian = (await linkLibrarian(
    {
      tgId: d.tgId,
      username: d.username,
      firstName: d.firstName,
      city: d.city ?? user.city ?? null,
      district: d.district,
    },
    { allowCreate: true },
  ))!

  // модерация: свои книги (админ) и режим без модерации одобряются сразу
  const autoApprove = !env.moderation || isAdmin(d.tgId)
  const now = new Date()

  // карточка у нас — всегда, чтобы полка/поиск видели её сразу
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
    addedAt: now,
    ownerId: librarian.id,
    notionStatus: 'pending',
    reviewStatus: autoApprove ? 'approved' : 'pending',
    submittedAt: now,
    reviewedAt: autoApprove ? now : null,
    reviewedByTg: autoApprove ? d.tgId : null,
  }
  let book = await prisma.book.create({ data: { ...data, search: buildSearch(data) } })
  invalidateFacets()

  // на проверку: в каталог и Notion не пускаем, показываем админам карточку
  if (!autoApprove) {
    const card = toCard({ ...book, owner: librarian })
    await Promise.resolve(moderationNotifier?.(card, librarian)).catch(() => {})
    return { book: card, notionStatus: book.notionStatus, notionError: null }
  }

  // одобрено сразу — заводим владельца и льём книгу в общую таблицу
  book = await sendBookToNotion(book.id, librarian)
  const card = toCard({ ...book, owner: librarian })
  if (book.notionStatus !== 'synced') {
    await Promise.resolve(
      notifier?.(card, book.notionError ?? 'запись в Notion выключена'),
    ).catch(() => {})
  }
  return { book: card, notionStatus: book.notionStatus, notionError: book.notionError }
}

export type ReviewResult = { card: BookCard; addedByTg: bigint | null }

/** Одобрить книгу с модерации: пускаем в каталог и в общую таблицу Notion. */
export async function approveBook(bookId: string, adminTg: bigint): Promise<ReviewResult | null> {
  const book = await prisma.book.findUnique({ where: { id: bookId }, include: { owner: true } })
  if (!book) return null
  if (book.reviewStatus !== 'approved') {
    await prisma.book.update({
      where: { id: bookId },
      data: { reviewStatus: 'approved', reviewedByTg: adminTg, reviewedAt: new Date() },
    })
    invalidateFacets()
  }
  let updated = await prisma.book.findUniqueOrThrow({ where: { id: bookId } })
  if (book.owner) updated = await sendBookToNotion(bookId, book.owner)
  return { card: toCard({ ...updated, owner: book.owner }), addedByTg: book.addedByTg }
}

/** Отклонить книгу: остаётся у владельца с причиной, в каталог/Notion не идёт. */
export async function rejectBook(
  bookId: string,
  adminTg: bigint,
  reason: string | null,
): Promise<ReviewResult | null> {
  const book = await prisma.book.findUnique({ where: { id: bookId }, include: { owner: true } })
  if (!book) return null
  const updated = await prisma.book.update({
    where: { id: bookId },
    data: {
      reviewStatus: 'rejected',
      reviewedByTg: adminTg,
      reviewedAt: new Date(),
      rejectionReason: reason?.slice(0, 300) ?? null,
    },
  })
  invalidateFacets()
  return { card: toCard({ ...updated, owner: book.owner }), addedByTg: book.addedByTg }
}

/* ── личная полка: состояния и действия владельца ─────────── */

/** Состояние книги на полке владельца — по нему группируем полку в Mini App. */
export function shelfState(b: {
  reviewStatus: string
  status: string
  notionStatus: string
}): 'active' | 'pending' | 'rejected' | 'onloan' | 'deleted' | 'syncerror' {
  if (b.reviewStatus === 'deleted') return 'deleted'
  if (b.reviewStatus === 'rejected') return 'rejected'
  if (b.reviewStatus === 'pending') return 'pending'
  if (b.status === 'busy') return 'onloan'
  if (b.notionStatus === 'failed') return 'syncerror'
  return 'active'
}

/** Книга владельца, если она действительно его; иначе код ошибки. */
async function ownedBook(bookId: string, ownerTg: bigint) {
  const book = await prisma.book.findUnique({ where: { id: bookId }, include: { owner: true } })
  if (!book) return { error: 'not_found' as const }
  const isOwner = book.owner?.tgId === ownerTg || book.addedByTg === ownerTg
  if (!isOwner) return { error: 'forbidden' as const }
  return { book }
}

export type ShelfEdit = {
  title?: string
  author?: string | null
  genres?: string[]
  languages?: string[]
  city?: string | null
  district?: string | null
}

/** Отредактировать книгу владельца: у нас и, для уже уехавших, в Notion. */
export async function editBook(bookId: string, ownerTg: bigint, f: ShelfEdit) {
  const r = await ownedBook(bookId, ownerTg)
  if ('error' in r) return r
  const b = r.book

  const data: Record<string, unknown> = {}
  if (f.title !== undefined) data.title = f.title.trim().slice(0, 300)
  if (f.author !== undefined) data.author = f.author?.trim().slice(0, 200) || null
  if (f.genres !== undefined) data.genres = f.genres.join(', ').slice(0, 300)
  if (f.languages !== undefined) data.languages = f.languages.join(', ').slice(0, 200)
  if (f.city !== undefined) data.city = f.city?.trim() || null
  if (f.district !== undefined) data.district = f.district?.trim() || null

  const merged = { ...b, ...data } as typeof b
  data.search = buildSearch(merged)
  const updated = await prisma.book.update({ where: { id: bookId }, data, include: { owner: true } })
  invalidateFacets()

  // синхронизированную книгу правим и в Notion, иначе синк вернёт старое значение
  if (updated.notionId && notionWriteEnabled()) {
    await updateBook(updated.notionId, updated.kind === 'game' ? 'game' : 'book', {
      title: f.title !== undefined ? updated.title : undefined,
      author: f.author !== undefined ? updated.author : undefined,
      genres: f.genres,
      languages: f.languages,
      cityDistrict:
        f.city !== undefined || f.district !== undefined
          ? cityDistrictOf(updated.city, updated.district)
          : undefined,
    }).catch((e) => console.error('[notion] правка книги не уехала:', e?.message ?? e))
  }
  return { card: toCard({ ...updated, owner: updated.owner }) }
}

/**
 * Мягкое удаление: запись остаётся (история/статистика), но уходит с полки и из
 * каталога. Книгу на руках так просто не удалить — можно скрыть после возврата.
 */
export async function softDeleteBook(bookId: string, ownerTg: bigint, hideAfterReturn = false) {
  const r = await ownedBook(bookId, ownerTg)
  if ('error' in r) return r
  const b = r.book

  if (b.status === 'busy') {
    if (!hideAfterReturn) return { error: 'has_active_loan' as const }
    await prisma.book.update({ where: { id: bookId }, data: { hideAfterReturn: true } })
    return { deferred: true as const }
  }

  const updated = await prisma.book.update({
    where: { id: bookId },
    data: {
      active: false,
      reviewStatus: 'deleted',
      deletedAt: new Date(),
      deletedByTg: ownerTg,
      hideAfterReturn: false,
    },
    include: { owner: true },
  })
  invalidateFacets()
  if (updated.notionId && notionWriteEnabled()) {
    await archiveRow(updated.notionId).catch((e) =>
      console.error('[notion] архивирование книги не удалось:', e?.message ?? e),
    )
  }
  return { card: toCard({ ...updated, owner: updated.owner }) }
}

/** Повторно отправить отклонённую книгу — снова через модерацию (или сразу, если её нет). */
export async function resubmitBook(bookId: string, ownerTg: bigint) {
  const r = await ownedBook(bookId, ownerTg)
  if ('error' in r) return r
  const b = r.book
  if (b.reviewStatus !== 'rejected') return { error: 'bad_state' as const }

  const autoApprove = !env.moderation || isAdmin(ownerTg)
  const now = new Date()
  if (autoApprove) {
    await prisma.book.update({
      where: { id: bookId },
      data: { reviewStatus: 'approved', reviewedAt: now, reviewedByTg: ownerTg, rejectionReason: null, submittedAt: now },
    })
    invalidateFacets()
    const book = b.owner ? await sendBookToNotion(bookId, b.owner) : await prisma.book.findUniqueOrThrow({ where: { id: bookId } })
    return { card: toCard({ ...book, owner: b.owner }), pending: false }
  }

  const updated = await prisma.book.update({
    where: { id: bookId },
    data: { reviewStatus: 'pending', submittedAt: now, rejectionReason: null },
    include: { owner: true },
  })
  invalidateFacets()
  const card = toCard({ ...updated, owner: updated.owner })
  if (updated.owner) await Promise.resolve(moderationNotifier?.(card, updated.owner)).catch(() => {})
  return { card, pending: true }
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
    // только одобренные — книги на модерации/отклонённые в общую таблицу не уходят
    where: {
      source: 'bot',
      reviewStatus: 'approved',
      notionId: null,
      notionStatus: { in: ['pending', 'failed'] },
    },
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
    where: {
      source: 'bot',
      reviewStatus: 'approved',
      notionId: null,
      notionStatus: { in: ['pending', 'failed'] },
    },
  })

/** Сколько книг ждёт модерации. */
export const moderationQueueCount = () =>
  prisma.book.count({ where: { reviewStatus: 'pending' } })

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

export type DupCheck = {
  /** такая же книга уже на полке самого пользователя — это ошибочный дубль */
  own: BookCard | null
  /** сколько таких же книг у ДРУГИХ библиотекарей — это нормальные экземпляры */
  others: { count: number; city: string | null }
}

/**
 * Различаем два случая: та же книга у самого пользователя (ошибочный дубль,
 * предупреждаем) и та же книга у других (нормальные экземпляры, просто подсказка).
 * Ключ совпадения: нормализованные название + автор + тип.
 */
export async function checkDuplicates(input: {
  title: string
  author?: string | null
  kind: 'book' | 'game'
  ownerTg?: bigint | null
}): Promise<DupCheck> {
  const nt = norm(input.title)
  if (nt.length < 3) return { own: null, others: { count: 0, city: null } }
  const na = norm(input.author || '')

  const candidates = await prisma.book.findMany({
    where: {
      active: true,
      kind: input.kind,
      reviewStatus: { in: ['approved', 'pending'] },
      search: { contains: nt },
    },
    include: { owner: true },
    take: 200,
  })

  // точное совпадение по названию; автор — если задан у обоих
  const matches = candidates.filter(
    (b) => norm(b.title) === nt && (!na || !b.author || norm(b.author) === na),
  )

  const ownLib = input.ownerTg
    ? await prisma.librarian.findUnique({ where: { tgId: input.ownerTg }, select: { id: true } })
    : null

  const own = ownLib ? matches.find((b) => b.ownerId === ownLib.id) : undefined
  const others = matches.filter(
    (b) => b.reviewStatus === 'approved' && (!ownLib || b.ownerId !== ownLib.id),
  )

  const cityCount = new Map<string, number>()
  for (const b of others) if (b.city) cityCount.set(b.city, (cityCount.get(b.city) ?? 0) + 1)
  const city = [...cityCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  return {
    own: own ? toCard({ ...own, owner: own.owner }) : null,
    others: { count: others.length, city },
  }
}
