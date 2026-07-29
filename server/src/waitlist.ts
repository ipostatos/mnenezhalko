/**
 * Очередь на занятую книгу: «сообщите, когда освободится» (issue #10).
 *
 * Четыре решения, которые здесь важнее кода:
 *
 * 1. **Очередь висит на экземпляре, а не на произведении.** Обратно тому, как
 *    устроены оценки (см. reviews.ts): оценивают текст, а ждут конкретную книгу
 *    у конкретного человека в конкретном городе, и обещание «сообщим» рождается
 *    из возврата именно этого экземпляра.
 * 2. **Обещание переживает падение процесса.** Возврат книги и выбор следующего
 *    в очереди происходят в одной транзакции (`promoteNextWaiting` зовётся
 *    внутри markReturned) и оставляют запись в состоянии `ready`. Отправка
 *    сообщения — дело внешнее и ненадёжное, поэтому это отдельный шаг, который
 *    добивает джоба. Если бы уведомление жило только в памяти обработчика,
 *    деплой в неудачную секунду молча съедал бы обещание.
 * 3. **Ждущие не видят друг друга.** Наружу уходит только число ожидающих и
 *    своя позиция. Ни имён, ни ников, ни tgId: это соседи по очереди, а не
 *    публичный список (правила контактов — privacy.ts).
 * 4. **Очередь не бывает вечной.** Мёртвая запись протухает по сроку, а если
 *    первый в очереди не пришёл за книгой, через сутки очередь переходит к
 *    следующему: иначе один молчун держит книгу в подвешенном состоянии, и
 *    остальные не узнают о ней никогда.
 *
 * Функции не знают о Fastify и grammY: на входе данные, на выходе данные —
 * поэтому проверяются тестами без сети (waitlist.test.ts).
 */
import type { Prisma } from '@prisma/client'
import { prisma } from './db.js'

/** Сколько живёт запись в очереди, если ничего не происходит. */
export const WAIT_TTL_DAYS = 60

/** Сколько книг можно ждать одновременно: очередь — не список желаний. */
export const MAX_WAITING_PER_USER = 20

/**
 * Сколько ждём реакции первого в очереди, прежде чем позвать следующего.
 * Сутки: за это время человек либо написал владельцу, либо не собирается.
 */
export const ESCALATE_AFTER_MS = 24 * 3600_000

/** Сколько раз пробуем доставить сообщение, прежде чем закрыть запись. */
export const NOTIFY_MAX_ATTEMPTS = 3

export type JoinError =
  /** свою книгу ждать незачем */
  | 'own_book'
  /** книга свободна: ждать нечего, надо просто написать владельцу */
  | 'not_busy'
  /** книги нет, она снята с полки или ещё на проверке */
  | 'book_unavailable'
  /** слишком много одновременных ожиданий */
  | 'too_many'

export type JoinResult = { ok: true; position: number; count: number } | { ok: false; error: JoinError }

const ttlFrom = (now: Date) => new Date(now.getTime() + WAIT_TTL_DAYS * 24 * 3600_000)

/** Активные записи очереди: и те, кто ждёт, и тот, кого уже позвали. */
const LIVE = ['waiting', 'ready'] as const

/**
 * Встать в очередь. Повторное нажатие не плодит вторую запись: уникальность
 * `bookId+userTg` держит база, а человек, уже получивший уведомление и
 * вставший снова, честно уходит в конец очереди (`createdAt` обновляется).
 */
export async function joinWaitlist(
  userTg: bigint,
  bookId: string,
  now = new Date(),
): Promise<JoinResult> {
  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: { id: true, status: true, active: true, reviewStatus: true, owner: { select: { tgId: true } } },
  })
  if (!book || !book.active || book.reviewStatus !== 'approved') {
    return { ok: false, error: 'book_unavailable' }
  }
  if (book.owner?.tgId === userTg) return { ok: false, error: 'own_book' }
  if (book.status !== 'busy') return { ok: false, error: 'not_busy' }

  const existing = await prisma.waiting.findUnique({
    where: { bookId_userTg: { bookId, userTg } },
    select: { id: true, status: true },
  })

  // лимит считаем только по чужим книгам сверх этой: повторное нажатие на ту,
  // в очереди на которую человек уже стоит, не должно упираться в потолок
  if (!existing || !LIVE.includes(existing.status as (typeof LIVE)[number])) {
    const active = await prisma.waiting.count({
      where: { userTg, status: { in: [...LIVE] }, expiresAt: { gt: now } },
    })
    if (active >= MAX_WAITING_PER_USER) return { ok: false, error: 'too_many' }
  }

  await prisma.waiting.upsert({
    where: { bookId_userTg: { bookId, userTg } },
    create: { bookId, userTg, expiresAt: ttlFrom(now), createdAt: now },
    // вернувшийся в очередь встаёт в конец: иначе человек, которого уже звали и
    // который книгу не забрал, вечно оставался бы первым
    update: {
      status: 'waiting',
      createdAt: now,
      expiresAt: ttlFrom(now),
      readyAt: null,
      notifiedAt: null,
      leftAt: null,
      attempts: 0,
    },
  })

  const view = await waitlistFor(bookId, userTg, now)
  return { ok: true, position: view.mine?.position ?? 1, count: view.count }
}

/** Уйти из очереди. Возвращает false, если человека в ней и не было. */
export async function leaveWaitlist(userTg: bigint, bookId: string, now = new Date()) {
  const r = await prisma.waiting.updateMany({
    where: { bookId, userTg, status: { in: [...LIVE] } },
    data: { status: 'left', leftAt: now },
  })
  return { left: r.count > 0 }
}

export type WaitlistView = {
  /** сколько человек ждёт эту книгу */
  count: number
  /** своё место в очереди — и только своё */
  mine: { position: number; status: string; readyAt: Date | null } | null
}

/**
 * Что показать в карточке книги. Ни имён, ни ников, ни tgId: владельцу нужно
 * число, ждущему — своё место, друг друга они не видят.
 */
export async function waitlistFor(
  bookId: string,
  viewerTg?: bigint | null,
  now = new Date(),
): Promise<WaitlistView> {
  const rows = await prisma.waiting.findMany({
    where: { bookId, status: { in: [...LIVE] }, expiresAt: { gt: now } },
    select: { userTg: true, status: true, readyAt: true },
    orderBy: { createdAt: 'asc' },
  })
  const count = rows.length
  if (viewerTg === undefined || viewerTg === null) return { count, mine: null }
  const idx = rows.findIndex((r) => r.userTg === viewerTg)
  if (idx < 0) return { count, mine: null }
  return {
    count,
    mine: { position: idx + 1, status: rows[idx].status, readyAt: rows[idx].readyAt },
  }
}

/** Сколько людей ждёт каждую из книг — одной выборкой на список (моя полка). */
export async function waitCountsFor(bookIds: string[], now = new Date()) {
  if (!bookIds.length) return new Map<string, number>()
  const rows = await prisma.waiting.groupBy({
    by: ['bookId'],
    where: { bookId: { in: bookIds }, status: { in: [...LIVE] }, expiresAt: { gt: now } },
    _count: { _all: true },
  })
  return new Map(rows.map((r) => [r.bookId, r._count._all]))
}

/**
 * Позвать следующего: книга освободилась.
 *
 * Зовётся ВНУТРИ транзакции возврата (loans.ts::markReturned), поэтому берёт
 * `tx`: «книга свободна» и «следующий выбран» должны стать правдой вместе.
 * Никого не выбирает повторно, пока есть неотработанный `ready` — иначе один
 * возврат и один откат возврата разослали бы уведомления половине очереди.
 */
export async function promoteNextWaiting(
  tx: Prisma.TransactionClient,
  bookId: string,
  now = new Date(),
): Promise<{ id: string; userTg: bigint } | null> {
  const alreadyReady = await tx.waiting.count({ where: { bookId, status: 'ready' } })
  if (alreadyReady) return null

  const next = await tx.waiting.findFirst({
    where: { bookId, status: 'waiting', expiresAt: { gt: now } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, userTg: true },
  })
  if (!next) return null

  await tx.waiting.update({
    where: { id: next.id },
    data: { status: 'ready', readyAt: now },
  })
  return next
}

/**
 * Книга ушла с полки (владелец скрыл её после возврата, модерация отклонила):
 * ждать больше нечего, очередь закрывается молча.
 */
export async function closeWaitlist(
  tx: Prisma.TransactionClient,
  bookId: string,
  now = new Date(),
) {
  const r = await tx.waiting.updateMany({
    where: { bookId, status: { in: [...LIVE] } },
    data: { status: 'left', leftAt: now },
  })
  return r.count
}

/**
 * Возврат отменили (undo в течение суток): книга снова на руках.
 *
 * Того, кому обещание ещё НЕ отправили, возвращаем в очередь на его прежнее
 * место — обещания не было, извиняться не за что. Того, кому сообщение уже
 * ушло, не трогаем: у человека на руках письмо «книга свободна», и молча
 * стирать его из очереди было бы хуже, чем оставить.
 */
export async function demoteUnsentReady(
  tx: Prisma.TransactionClient,
  bookId: string,
): Promise<number> {
  const r = await tx.waiting.updateMany({
    where: { bookId, status: 'ready', notifiedAt: null },
    data: { status: 'waiting', readyAt: null },
  })
  return r.count
}

export type PendingNotice = {
  id: string
  userTg: bigint
  attempts: number
  book: { id: string; title: string; author: string | null; city: string | null }
  ownerName: string | null
  ownerTelegram: string | null
}

/**
 * Кому надо отправить «книга освободилась»: записи в `ready` без доставки.
 *
 * Именно здесь обещание и оживает после рестарта: список берётся из базы, а не
 * из памяти обработчика возврата.
 */
export async function pendingNotices(limit = 50, now = new Date()): Promise<PendingNotice[]> {
  const rows = await prisma.waiting.findMany({
    where: {
      status: 'ready',
      notifiedAt: null,
      expiresAt: { gt: now },
      attempts: { lt: NOTIFY_MAX_ATTEMPTS },
    },
    orderBy: { readyAt: 'asc' },
    take: limit,
    include: {
      book: {
        select: {
          id: true,
          title: true,
          author: true,
          city: true,
          owner: { select: { name: true, telegram: true } },
        },
      },
    },
  })
  return rows.map((r) => ({
    id: r.id,
    userTg: r.userTg,
    attempts: r.attempts,
    book: {
      id: r.book.id,
      title: r.book.title,
      author: r.book.author,
      city: r.book.city,
    },
    ownerName: r.book.owner?.name ?? null,
    ownerTelegram: r.book.owner?.telegram ?? null,
  }))
}

/** Сообщение доставлено: очередь для этого человека закрыта. */
export async function markNotified(id: string, now = new Date()) {
  await prisma.waiting.update({
    where: { id },
    data: { status: 'notified', notifiedAt: now },
  })
}

/**
 * Доставить не удалось. После NOTIFY_MAX_ATTEMPTS попыток запись закрывается и
 * очередь идёт дальше: человек мог заблокировать бота, и держать из-за него
 * книгу «обещанной» нечестно к остальным.
 */
export async function markNotifyFailed(id: string, now = new Date()) {
  const row = await prisma.waiting.update({
    where: { id },
    data: { attempts: { increment: 1 } },
    select: { attempts: true, bookId: true },
  })
  if (row.attempts >= NOTIFY_MAX_ATTEMPTS) {
    await prisma.waiting.update({ where: { id }, data: { status: 'left', leftAt: now } })
  }
  return row
}

/** Протухшие записи: очередь, о которой все забыли, не живёт вечно. */
export async function expireWaitings(now = new Date()) {
  const r = await prisma.waiting.updateMany({
    where: { status: { in: [...LIVE] }, expiresAt: { lte: now } },
    data: { status: 'left', leftAt: now },
  })
  return r.count
}

/**
 * Первый в очереди не пришёл: книга всё ещё свободна, сутки прошли — зовём
 * следующего. Без этого один молчун держал бы книгу в подвешенном состоянии, а
 * остальные не узнали бы о ней никогда.
 */
export async function escalateStale(now = new Date(), after = ESCALATE_AFTER_MS) {
  const stale = await prisma.waiting.findMany({
    where: {
      // именно `notified`: эскалируем того, кому сообщение ДОШЛО и кто на него
      // не отреагировал. Недоставленное обещание (`ready`) сначала добьёт
      // рассылка — передавать очередь дальше, не позвав человека, нечестно
      status: 'notified',
      notifiedAt: { lt: new Date(now.getTime() - after) },
      book: { status: 'free', active: true },
    },
    select: { id: true, bookId: true },
    take: 100,
  })
  let moved = 0
  for (const row of stale) {
    // закрываем «позванного» и зовём следующего одной транзакцией: иначе на
    // обрыве книга осталась бы без ready вовсе, и очередь встала бы навсегда
    const promoted = await prisma.$transaction(async (tx) => {
      await tx.waiting.update({
        where: { id: row.id },
        data: { status: 'left', leftAt: now },
      })
      return promoteNextWaiting(tx, row.bookId, now)
    })
    if (promoted) moved++
  }
  return { checked: stale.length, moved }
}

/** Адаптер отправки: в проде — bot.api.sendMessage, в тестах — фейковый сборщик. */
export type NoticeSend = (
  chatId: string,
  text: string,
  opts?: { reply_markup?: unknown },
) => Promise<unknown>

/** Текст письма «книга освободилась». Отдельно от отправки — чтобы проверять. */
export function noticeText(n: PendingNotice): string {
  const who = n.ownerTelegram ? `@${n.ownerTelegram}` : (n.ownerName ?? 'владельцу')
  const where = n.book.city ? ` (${n.book.city})` : ''
  return (
    `📗 «${n.book.title}»${n.book.author ? ` — ${n.book.author}` : ''} освободилась!\n\n` +
    `Вы просили сообщить. Книга у ${who}${where}: напишите, если ещё актуально. ` +
    'Другие в очереди узнают о ней через сутки, так что лучше не тянуть.'
  )
}

/**
 * Разослать обещанное. Одна и та же функция работает и сразу после возврата, и
 * в джобе-добойщике: список берётся из базы, поэтому повторный вызов ничего не
 * дублирует (доставленное уходит в `notified`).
 *
 * Ошибка отправки одному не срывает остальных: человек мог заблокировать бота,
 * и это не повод молчать всей очереди.
 */
export async function runWaitlistNotices(opts: {
  send: NoticeSend
  now?: Date
  limit?: number
  delayMs?: number
  /** ссылка на карточку книги в Mini App, если есть куда вести */
  bookUrl?: (bookId: string) => string | null
}): Promise<{ pending: number; sent: number; failed: number }> {
  const now = opts.now ?? new Date()
  const list = await pendingNotices(opts.limit ?? 50, now)
  let sent = 0
  let failed = 0

  for (const n of list) {
    const url = opts.bookUrl?.(n.book.id) ?? null
    const keyboard = [
      // web_app, а не обычная ссылка: карточка живёт в Mini App, и человек
      // попадает сразу на неё, не проходя главную заново
      ...(url ? [[{ text: '📖 Открыть карточку', web_app: { url } }]] : []),
      [{ text: '🔕 Больше не жду', callback_data: `wait:stop:${n.book.id}` }],
    ]
    try {
      await opts.send(String(n.userTg), noticeText(n), {
        reply_markup: { inline_keyboard: keyboard },
      })
      await markNotified(n.id, now)
      sent++
    } catch {
      await markNotifyFailed(n.id, now)
      failed++
    }
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
  }
  return { pending: list.length, sent, failed }
}

/** Мои ожидания — для экрана «я жду» и чтобы человек не терял, где стоит. */
export async function myWaitings(userTg: bigint, now = new Date()) {
  return prisma.waiting.findMany({
    where: { userTg, status: { in: [...LIVE] }, expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
    include: { book: { select: { id: true, title: true, author: true, status: true } } },
    take: 50,
  })
}
