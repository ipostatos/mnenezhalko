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
import { toCard, searchBooks, invalidateFacets, split, type BookCard } from './search.js'
import {
  archiveRow,
  createBook,
  createOwner,
  notionWriteEnabled,
  stableNotionRowId,
  updateBook,
} from './notion-write.js'
import { linkLibrarian } from './librarian.js'
import { sanitizeGenres, sanitizeLanguages } from './taxonomy.js'

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
  /** админ добавляет от имени этого библиотекаря — книга принадлежит ему, не адду */
  ownerLibrarianId?: string | null
}

/**
 * Почему книга оказалась в том состоянии, в каком оказалась. Раньше об этом
 * можно было только догадываться по `reviewStatus`: при включённой модерации
 * админ сохранял книгу и она сразу появлялась в каталоге — со стороны это
 * выглядело как «модерация не работает» (вопрос user 5.08.2026). Правило не
 * менялось: свои книги админ публикует сам (это и есть право модератора), но
 * теперь интерфейс обязан это сказать вслух.
 */
export type ModerationOutcome =
  | { state: 'pending' }
  | { state: 'published'; reason: 'admin' | 'moderation_off' }

export type ShelfResult = {
  book: BookCard
  notionStatus: string
  notionError: string | null
  moderation: ModerationOutcome
  /** готовая человеческая фраза к этому исходу — одна на бота и Mini App */
  moderationNotice: string | null
}

/**
 * Текст об исходе модерации. Живёт на сервере ровно по той же причине, что и
 * `bookDecisionNotice`: две похожие фразы про одно событие (одна в боте, другая
 * в приложении) рано или поздно разъезжаются, а человеку важно, что это одно
 * и то же правило.
 */
export function moderationNotice(m: ModerationOutcome): string | null {
  if (m.state === 'pending') {
    return 'Книга отправлена на проверку модератору. Как одобрят — она появится в библиотеке, и бот вам сообщит.'
  }
  if (m.reason === 'admin') {
    return 'Книга опубликована сразу, потому что вы администратор. Книги обычных участников сначала уходят на проверку.'
  }
  return null // модерация выключена — объяснять нечего, это обычный порядок
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
      const notionId = await createOwner(
        {
          name: librarian.name,
          telegram: librarian.telegram,
          instagram: librarian.instagram,
          cityDistrict: cityDistrictOf(librarian.city, librarian.district),
        },
        // детерминированный id: ретрай после сбоя попадает в ту же строку Owners
        stableNotionRowId(`owner:${librarian.id}`),
      )
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

  // библиотекарь-владелец: либо явно заданный (админ добавляет от чьего-то имени),
  // либо сам добавляющий — единая идентификация по tgId → нику → создание
  let librarian: Librarian
  if (d.ownerLibrarianId) {
    const found = await prisma.librarian.findUnique({ where: { id: d.ownerLibrarianId } })
    if (!found) throw new Error('librarian_not_found')
    librarian = found
  } else {
    librarian = (await linkLibrarian(
      {
        tgId: d.tgId,
        username: d.username,
        firstName: d.firstName,
        city: d.city ?? user.city ?? null,
        district: d.district,
      },
      { allowCreate: true },
    ))!
  }

  // модерация: свои книги (админ) и режим без модерации одобряются сразу
  const autoApprove = !env.moderation || isAdmin(d.tgId)
  // «почему» отделено от «что»: у админа при включённой модерации это его право
  // модератора, а не отключённая проверка — интерфейс должен назвать причину
  const moderation: ModerationOutcome = !autoApprove
    ? { state: 'pending' }
    : { state: 'published', reason: env.moderation ? 'admin' : 'moderation_off' }
  const now = new Date()

  // карточка у нас — всегда, чтобы полка/поиск видели её сразу
  const city = d.city ?? librarian.city ?? null
  const district = d.district ?? librarian.district ?? null
  // жанр и язык — только из справочника Notion: своё значение, уехав в общую
  // таблицу, навсегда добавило бы туда новый вариант (см. taxonomy.ts)
  const genres = await sanitizeGenres(d.genres ?? [])
  const languages = await sanitizeLanguages(d.languages ?? [])
  const data = {
    kind: d.kind,
    title: d.title.trim().slice(0, 300),
    author: d.author?.trim().slice(0, 200) || null,
    genres: genres.join(', ').slice(0, 300),
    languages: languages.join(', ').slice(0, 200),
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
    return {
      book: card,
      notionStatus: book.notionStatus,
      notionError: null,
      moderation,
      moderationNotice: moderationNotice(moderation),
    }
  }

  // одобрено сразу — заводим владельца и льём книгу в общую таблицу
  book = await sendBookToNotion(book.id, librarian)
  const card = toCard({ ...book, owner: librarian })
  if (book.notionStatus !== 'synced') {
    await Promise.resolve(
      notifier?.(card, book.notionError ?? 'запись в Notion выключена'),
    ).catch(() => {})
  }
  return {
    book: card,
    notionStatus: book.notionStatus,
    notionError: book.notionError,
    moderation,
    moderationNotice: moderationNotice(moderation),
  }
}

export type ReviewResult = { card: BookCard; addedByTg: bigint | null }

/**
 * Что человек получает о решении по своей книге. Текст один и тот же, откуда
 * бы решение ни пришло — из кнопки в боте или с админского экрана Mini App:
 * два похожих письма об одном событии рано или поздно разошлись бы, а человеку
 * важно, что это одно и то же решение.
 */
export function bookDecisionNotice(
  decision: 'approve' | 'reject',
  title: string,
  reason?: string | null,
): string {
  if (decision === 'approve') {
    return `✅ Ваша книга «${title}» прошла проверку и появилась в библиотеке. Спасибо!`
  }
  return [
    `К сожалению, книга «${title}» не прошла проверку.`,
    reason?.trim() ? `Причина: ${reason.trim()}.` : '',
    'Книгу можно поправить на «Моей полке» и отправить снова; если это ошибка — напишите @LizavetaZh.',
  ]
    .filter(Boolean)
    .join(' ')
}

/** Зависший approving старше этого срока можно подхватить заново (процесс упал). */
export const APPROVING_STALE_MS = 10 * 60_000

export type ApproveOutcome =
  /** одобрено сейчас; `already` — повторный тап по уже одобренной */
  | ({ status: 'approved'; already: boolean } & ReviewResult)
  /** другой админ жмёт «одобрить» прямо сейчас — не дублируем */
  | { status: 'in_progress' }
  /** отклонённую/удалённую так не одобрить — только явный resubmit */
  | { status: 'bad_state'; reviewStatus: string }
  | { status: 'not_found' }
  /** публикация упала; книга возвращена в pending — можно повторить */
  | { status: 'failed'; error: string }

/**
 * Одобрить книгу с модерации — идемпотентно и атомарно.
 *
 * Карточка «на проверку» уходит КАЖДОМУ админу, поэтому два одобрения (или
 * двойной тап) — штатная ситуация, а не гонка. Инварианты: книгу можно одобрить
 * один раз; публикацию в Notion выполняет один процесс; повторный callback
 * получает `already`, а не вторую строку в таблице. Условный переход
 * pending → approving в updateMany атомарен (SQLite — один писатель); ретраи
 * создают строку Notion с детерминированным id (см. stableNotionRowId) — даже
 * упавший на полпути повтор не плодит дубли.
 */
export async function approveBook(bookId: string, adminTg: bigint): Promise<ApproveOutcome> {
  const book = await prisma.book.findUnique({ where: { id: bookId }, include: { owner: true } })
  if (!book) return { status: 'not_found' }
  if (book.reviewStatus === 'approved') {
    return {
      status: 'approved',
      already: true,
      card: toCard({ ...book, owner: book.owner }),
      addedByTg: book.addedByTg,
    }
  }
  if (book.reviewStatus === 'rejected' || book.reviewStatus === 'deleted') {
    return { status: 'bad_state', reviewStatus: book.reviewStatus }
  }

  // забираем право на одобрение: pending → approving; зависший approving
  // (процесс упал посреди публикации) можно подхватить спустя таймаут
  const claimed = await prisma.book.updateMany({
    where: {
      id: bookId,
      OR: [
        { reviewStatus: 'pending' },
        {
          reviewStatus: 'approving',
          approvalStartedAt: { lt: new Date(Date.now() - APPROVING_STALE_MS) },
        },
      ],
    },
    data: {
      reviewStatus: 'approving',
      approvalStartedAt: new Date(),
      approvalStartedByTg: adminTg,
      approvalAttempt: { increment: 1 },
    },
  })
  if (claimed.count === 0) return { status: 'in_progress' }

  try {
    let updated = await prisma.book.findUniqueOrThrow({ where: { id: bookId } })
    if (book.owner) updated = await sendBookToNotion(bookId, book.owner)
    updated = await prisma.book.update({
      where: { id: bookId },
      data: { reviewStatus: 'approved', reviewedByTg: adminTg, reviewedAt: new Date() },
    })
    invalidateFacets()
    return {
      status: 'approved',
      already: false,
      card: toCard({ ...updated, owner: book.owner }),
      addedByTg: book.addedByTg,
    }
  } catch (e: any) {
    const error = String(e?.message ?? e).slice(0, 300)
    // повторяемое состояние: возвращаем pending, чтобы ретрай продолжил ту же
    // операцию (строка Notion по детерминированному id не задвоится)
    await prisma.book
      .update({ where: { id: bookId }, data: { reviewStatus: 'pending' } })
      .catch(() => {})
    console.error('[moderation] одобрение не удалось:', error)
    return { status: 'failed', error }
  }
}

/** Отклонить книгу: остаётся у владельца с причиной, в каталог/Notion не идёт. */
export async function rejectBook(
  bookId: string,
  adminTg: bigint,
  reason: string | null,
): Promise<ReviewResult | null> {
  const book = await prisma.book.findUnique({ where: { id: bookId }, include: { owner: true } })
  if (!book) return null
  // другой админ прямо сейчас одобряет — не выдёргиваем книгу у него из-под рук
  if (book.reviewStatus === 'approving') return null
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
  // approving — мимолётное состояние одобрения, для владельца это всё ещё «на проверке»
  if (b.reviewStatus === 'pending' || b.reviewStatus === 'approving') return 'pending'
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
  // правка тоже держится справочника, но не стирает то, что уже стоит у книги:
  // у трёх десятков старых значений («Художка», «Нонфик») своя история, и правка
  // названия не должна молча выкидывать жанры
  let genres: string[] | undefined
  let languages: string[] | undefined
  if (f.genres !== undefined) {
    genres = await sanitizeGenres(f.genres, split(b.genres))
    data.genres = genres.join(', ').slice(0, 300)
  }
  if (f.languages !== undefined) {
    languages = await sanitizeLanguages(f.languages, split(b.languages))
    data.languages = languages.join(', ').slice(0, 200)
  }
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
      // в Notion уезжает ПРОВЕРЕННЫЙ список, а не то, что прислал клиент
      genres,
      languages,
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

  const wantArchive = Boolean(b.notionId && notionWriteEnabled())
  const updated = await prisma.book.update({
    where: { id: bookId },
    data: {
      active: false,
      reviewStatus: 'deleted',
      deletedAt: new Date(),
      deletedByTg: ownerTg,
      hideAfterReturn: false,
      // строку в Notion надо заархивировать; флаг снимаем только после успеха,
      // упавшая попытка дожимается flushPending — раньше ошибка глоталась, и
      // единственной защитой от «воскрешения» был бы следующий ручной заход
      notionArchivePending: wantArchive,
    },
    include: { owner: true },
  })
  invalidateFacets()
  if (wantArchive) {
    await archiveRow(updated.notionId!)
      .then(() =>
        prisma.book.update({ where: { id: bookId }, data: { notionArchivePending: false } }),
      )
      .catch((e) =>
        console.error('[notion] архивирование книги не удалось (дожмётся flushPending):', e?.message ?? e),
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

/** Одна попытка положить уже созданную карточку в общую таблицу. Идемпотентна:
 * у книги с notionId строка уже есть — второй раз не создаём, а новая строка
 * создаётся с детерминированным id (ретрай попадает в ту же страницу). */
async function pushToNotion(bookId: string, previousError: string | null = null) {
  const book = await prisma.book.findUniqueOrThrow({
    where: { id: bookId },
    include: { owner: true },
  })

  if (book.notionId) {
    return {
      book: await prisma.book.update({
        where: { id: bookId },
        data: { notionStatus: 'synced', notionError: null },
      }),
    }
  }

  if (!notionWriteEnabled()) {
    return {
      book: await prisma.book.update({
        where: { id: bookId },
        data: { notionStatus: 'pending', notionError: previousError },
      }),
    }
  }

  try {
    const notionId = await createBook(
      {
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
      },
      stableNotionRowId(`book:${book.id}`),
    )
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

  // недоархивированные удаления: без дожима строка оставалась бы в Notion,
  // а от «воскрешения» защищал бы только tombstone в синке
  const archives = await prisma.book.findMany({
    where: { notionArchivePending: true, notionId: { not: null } },
    select: { id: true, notionId: true },
    take: limit,
  })
  for (const a of archives) {
    try {
      await archiveRow(a.notionId!)
      await prisma.book.update({ where: { id: a.id }, data: { notionArchivePending: false } })
      ok++
    } catch (e: any) {
      console.error('[notion] повторное архивирование не удалось:', e?.message ?? e)
      failed++
    }
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
  /** такие же книги у ДРУГИХ библиотекарей — это нормальные экземпляры */
  others: {
    /** всего экземпляров у других */
    count: number
    /**
     * Город с наибольшим числом экземпляров. Оставлен для совместимости, но
     * ПОКАЗЫВАТЬ его вместе с общим `count` нельзя: при экземплярах в разных
     * городах получается «3 экземпляра в Варшаве», хотя в Варшаве только один.
     * Для текста человеку берите `byCity`.
     */
    city: string | null
    /** разбивка по городам, от большего к меньшему */
    byCity: { city: string; count: number }[]
    /** экземпляры, у которых город не указан */
    unknownCity: number
    /** готовая фраза «2 в Варшаве, 1 в Кракове» — одна на бота и Mini App */
    where: string
  }
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
  /** админ проверяет полку не свою, а того, ЗА КОГО вносит книгу */
  ownerLibrarianId?: string | null
}): Promise<DupCheck> {
  const empty = { count: 0, city: null, byCity: [], unknownCity: 0, where: '' }
  const nt = norm(input.title)
  if (nt.length < 3) return { own: null, others: empty }
  const na = norm(input.author || '')

  const candidates = await prisma.book.findMany({
    where: {
      active: true,
      kind: input.kind,
      reviewStatus: { in: ['approved', 'pending'] },
      search: { contains: nt },
    },
    include: { owner: true },
    // берём с запасом: точное совпадение названия отбираем уже в памяти, а
    // популярное название встречается подстрокой в десятках чужих записей
    take: 500,
  })

  // точное совпадение по названию; автор — если задан у обоих
  const matches = candidates.filter(
    (b) => norm(b.title) === nt && (!na || !b.author || norm(b.author) === na),
  )

  // «своя» полка — та, на которую книга и ляжет: для админа, вносящего книгу за
  // человека, это полка человека, иначе он видел бы дубли у себя, а не у него
  const ownLib = input.ownerLibrarianId
    ? await prisma.librarian.findUnique({
        where: { id: input.ownerLibrarianId },
        select: { id: true },
      })
    : input.ownerTg
      ? await prisma.librarian.findUnique({ where: { tgId: input.ownerTg }, select: { id: true } })
      : null

  const own = ownLib ? matches.find((b) => b.ownerId === ownLib.id) : undefined
  const others = matches.filter(
    (b) => b.reviewStatus === 'approved' && (!ownLib || b.ownerId !== ownLib.id),
  )

  // город берём у книги, а если его там нет — у владельца: в Notion город часто
  // заполнен только в карточке библиотекаря, и без этого экземпляр «терял» город
  const cityCount = new Map<string, number>()
  let unknownCity = 0
  for (const b of others) {
    const city = b.city || b.owner?.city || null
    if (city) cityCount.set(city, (cityCount.get(city) ?? 0) + 1)
    else unknownCity++
  }
  const byCity = [...cityCount.entries()]
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city))

  const stats = { count: others.length, city: byCity[0]?.city ?? null, byCity, unknownCity }
  return {
    own: own ? toCard({ ...own, owner: own.owner }) : null,
    others: { ...stats, where: describeOthers(stats) },
  }
}

/**
 * Человеческая формулировка «где и сколько»: перечисляем города с числами, а не
 * общее число рядом с одним городом. Пример: «3 экземпляра: 2 в Варшаве,
 * 1 в Кракове».
 */
export function describeOthers(o: Omit<DupCheck['others'], 'where'>): string {
  if (!o.count) return ''
  const parts = o.byCity.slice(0, 3).map((c) => `${c.count} в ${c.city}`)
  const restCities = o.byCity.length - 3
  if (restCities > 0) {
    const rest = o.byCity.slice(3).reduce((n, c) => n + c.count, 0)
    parts.push(`${rest} в других городах`)
  }
  if (o.unknownCity) parts.push(`${o.unknownCity} без города`)
  // единственный экземпляр в одном городе описываем короче: «1 в Варшаве»
  return parts.join(', ')
}
