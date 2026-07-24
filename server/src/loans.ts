/**
 * «У кого моя книга сейчас».
 *
 * Владелец отмечает: название + ник человека, которому отдал. Дальше бот ведёт
 * учёт сам: карточка книги на полке становится «на руках», через месяц (или к
 * своему сроку) прилетает вежливое напоминание обеим сторонам, а вернуть книгу
 * можно одной кнопкой — с любой стороны.
 *
 * Тонкость Telegram: боту нельзя написать первым тому, кто с ним не общался.
 * Поэтому у выдачи есть ссылка-приглашение `?start=loan_<id>` — владелец
 * пересылает её, читатель открывает, и с этого момента напоминания доходят.
 */
import { prisma } from './db.js'
import { tgHandle } from './notion.js'
import { archiveRow, notionWriteEnabled } from './notion-write.js'
import { invalidateFacets } from './search.js'

/** Срок по умолчанию — месяц: столько обычно и держат книгу. */
const DEFAULT_DAYS = 30

/** Окно, в которое можно отменить возврат. */
const UNDO_WINDOW_MS = 24 * 3600_000

export type LoanEventKind =
  | 'created'
  | 'claimed'
  | 'reminded'
  | 'returned'
  | 'reopened'
  | 'cancelled'

/** Пишет событие выдачи; не роняет основной путь, если запись не удалась. */
export function logLoanEvent(loanId: string, kind: LoanEventKind, byTg?: bigint | null, meta?: string) {
  return prisma.loanEvent
    .create({ data: { loanId, kind, byTg: byTg ?? null, meta: meta ?? null } })
    .catch((e) => console.error('[loans] событие не записалось:', e?.message ?? e))
}

export type LoanDraft = {
  ownerTg: bigint
  title: string
  bookId?: string | null
  holder: string
  holderName?: string | null
  days?: number | null
  note?: string | null
  /** когда книгу отдали: записать можно и задним числом */
  takenAt?: Date | string | null
}

const day = 86_400_000

/**
 * Дата выдачи: книгу часто вспоминают записать не в тот же день, поэтому
 * принимаем прошлое (до пяти лет назад), а будущее считаем опиской.
 */
function parseTakenAt(value?: Date | string | null): Date {
  if (!value) return new Date()
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) throw new Error('bad_date')
  const now = Date.now()
  if (d.getTime() > now + day) throw new Error('future_date')
  if (d.getTime() < now - 5 * 365 * day) throw new Error('too_old_date')
  return d.getTime() > now ? new Date() : d
}

export async function createLoan(d: LoanDraft) {
  const holderUsername = tgHandle(d.holder)
  const title = d.title.trim().slice(0, 300)
  if (!title) throw new Error('empty_title')
  if (!holderUsername) throw new Error('bad_holder')

  // если такой человек уже писал боту — сможем напоминать сразу
  const known = await prisma.user.findFirst({
    where: { username: { equals: holderUsername } },
    select: { tgId: true, firstName: true },
  })

  const days = d.days === null ? null : d.days ?? DEFAULT_DAYS
  const takenAt = parseTakenAt(d.takenAt)
  const loan = await prisma.loan.create({
    data: {
      title,
      bookId: d.bookId ?? null,
      ownerTg: d.ownerTg,
      holderUsername,
      holderName: d.holderName ?? known?.firstName ?? null,
      holderTg: known?.tgId ?? null,
      takenAt,
      // срок отсчитываем от дня выдачи, а не от момента записи
      dueAt: days ? new Date(takenAt.getTime() + days * day) : null,
      note: d.note?.slice(0, 500) ?? null,
    },
    include: { book: true },
  })

  // на полке книга помечается занятой, чтобы её не искали зря
  if (loan.bookId) {
    await prisma.book.update({ where: { id: loan.bookId }, data: { status: 'busy' } })
  }
  await logLoanEvent(loan.id, 'created', d.ownerTg)
  return loan
}

export const listLoans = (ownerTg: bigint, status: 'active' | 'returned' | 'all' = 'active') =>
  prisma.loan.findMany({
    where: { ownerTg, ...(status === 'all' ? {} : { status }) },
    orderBy: [{ status: 'asc' }, { takenAt: 'desc' }],
    include: { book: { select: { id: true, title: true, coverUrl: true } } },
    take: 100,
  })

/** Книги, которые человек взял у других. */
export const listBorrowed = (holderTg: bigint) =>
  prisma.loan.findMany({
    where: { holderTg, status: 'active' },
    orderBy: { takenAt: 'desc' },
    include: { book: { select: { id: true, title: true, coverUrl: true } } },
    take: 100,
  })

export async function markReturned(id: string, byTg: bigint) {
  const loan = await prisma.loan.findUnique({ where: { id } })
  if (!loan) return null
  // закрыть выдачу может владелец или сам читатель
  if (loan.ownerTg !== byTg && loan.holderTg !== byTg) return null

  const updated = await prisma.loan.update({
    where: { id },
    data: { status: 'returned', returnedAt: new Date() },
    include: { book: true },
  })
  await logLoanEvent(id, 'returned', byTg)
  if (updated.bookId) {
    const stillOut = await prisma.loan.count({
      where: { bookId: updated.bookId, status: 'active' },
    })
    if (!stillOut) {
      const book = await prisma.book.findUnique({ where: { id: updated.bookId } })
      // владелец просил скрыть книгу после возврата — мягко удаляем её сейчас
      if (book?.hideAfterReturn) {
        await prisma.book.update({
          where: { id: book.id },
          data: {
            status: 'free',
            active: false,
            reviewStatus: 'deleted',
            deletedAt: new Date(),
            deletedByTg: loan.ownerTg,
            hideAfterReturn: false,
          },
        })
        invalidateFacets()
        if (book.notionId && notionWriteEnabled()) {
          await archiveRow(book.notionId).catch(() => {})
        }
      } else {
        await prisma.book.update({ where: { id: updated.bookId }, data: { status: 'free' } })
      }
    }
  }
  return updated
}

/**
 * Привязывает читателя к выдаче, когда он открыл ссылку-приглашение.
 * Заодно подхватывает все прочие его выдачи по нику.
 */
export async function claimLoans(tgId: bigint, username?: string | null, loanId?: string) {
  const ids = new Set<string>()
  if (loanId) {
    const l = await prisma.loan.findFirst({
      where: { id: loanId, holderTg: null },
      select: { id: true },
    })
    if (l) ids.add(l.id)
  }
  if (username) {
    const rows = await prisma.loan.findMany({
      where: { holderUsername: username, holderTg: null, status: 'active' },
      select: { id: true },
    })
    rows.forEach((r) => ids.add(r.id))
  }
  if (!ids.size) return 0
  await prisma.loan.updateMany({ where: { id: { in: [...ids] } }, data: { holderTg: tgId } })
  for (const id of ids) await logLoanEvent(id, 'claimed', tgId)
  return ids.size
}

/**
 * Отменить возврат (undo): в окне 24 ч и только если книгу за это время не
 * выдали кому-то ещё. Возвращает обновлённую выдачу либо код ошибки.
 */
export async function reopenLoan(id: string, byTg: bigint) {
  const loan = await prisma.loan.findUnique({ where: { id }, include: { book: true } })
  if (!loan) return { error: 'not_found' as const }
  if (loan.ownerTg !== byTg && loan.holderTg !== byTg) return { error: 'forbidden' as const }
  if (loan.status !== 'returned') return { error: 'not_returned' as const }
  if (!loan.returnedAt || Date.now() - loan.returnedAt.getTime() > UNDO_WINDOW_MS) {
    return { error: 'too_late' as const }
  }
  if (loan.bookId) {
    const relent = await prisma.loan.count({
      where: { bookId: loan.bookId, status: 'active', id: { not: id } },
    })
    if (relent) return { error: 'book_relent' as const }
    const book = await prisma.book.findUnique({ where: { id: loan.bookId } })
    if (book?.active) await prisma.book.update({ where: { id: loan.bookId }, data: { status: 'busy' } })
  }
  const updated = await prisma.loan.update({
    where: { id },
    data: { status: 'active', returnedAt: null },
    include: { book: true },
  })
  await logLoanEvent(id, 'reopened', byTg)
  return { loan: updated }
}

/** Закрытые выдачи (обе стороны) — для вкладки «История». */
export const listHistory = (tgId: bigint) =>
  prisma.loan.findMany({
    where: { status: 'returned', OR: [{ ownerTg: tgId }, { holderTg: tgId }] },
    orderBy: { returnedAt: 'desc' },
    include: { book: { select: { id: true, title: true, coverUrl: true } } },
    take: 40,
  })

/** Можно ли ещё отменить возврат этой выдачи. */
export const canUndoLoan = (loan: { returnedAt: Date | null }, now = new Date()) =>
  !!loan.returnedAt && now.getTime() - loan.returnedAt.getTime() <= UNDO_WINDOW_MS

export const loanById = (id: string) =>
  prisma.loan.findUnique({ where: { id }, include: { book: true } })

/**
 * Выдачи, по которым пора напомнить: срок вышел, а напоминали больше недели
 * назад (или ещё ни разу). Без срока — молчим, это осознанный выбор владельца.
 */
export async function dueLoans(now = new Date()) {
  return prisma.loan.findMany({
    where: {
      status: 'active',
      dueAt: { not: null, lte: now },
      OR: [
        { remindedAt: null },
        { remindedAt: { lte: new Date(now.getTime() - 7 * day) } },
      ],
    },
    take: 50,
  })
}

export async function markReminded(id: string) {
  const loan = await prisma.loan.update({ where: { id }, data: { remindedAt: new Date() } })
  await logLoanEvent(id, 'reminded')
  return loan
}

/** Адаптер отправки: в проде — bot.api.sendMessage, в тестах — фейковый сборщик. */
export type ReminderSend = (
  chatId: string,
  text: string,
  opts?: { reply_markup?: unknown; link_preview_options?: unknown },
) => Promise<unknown>

/**
 * Рассылка напоминаний по просроченным выдачам. Ядро без grammY: время (`now`)
 * и отправку (`send`) инъектируем, поэтому логику можно проверить тестом, а не
 * ждать реальный месяц. Ошибка отправки одному получателю не срывает остальных.
 */
export async function runOverdueReminders(opts: {
  send: ReminderSend
  botUsername: string
  now?: Date
  delayMs?: number
}): Promise<{ loans: number; sent: number; failed: number }> {
  const now = opts.now ?? new Date()
  const loans = await dueLoans(now)
  let sent = 0
  let failed = 0
  const track = (p: Promise<unknown>) =>
    p.then(() => {
      sent++
    }).catch(() => {
      failed++
    })

  for (const loan of loans) {
    const days = daysOut(loan.takenAt, now)
    const kb = {
      inline_keyboard: [[{ text: '✅ Книга вернулась', callback_data: `loan:back:${loan.id}` }]],
    }
    const link = `https://t.me/${opts.botUsername}?start=loan_${loan.id}`

    if (loan.holderTg) {
      await track(
        opts.send(
          String(loan.holderTg),
          `📗 Напоминание: книга «${loan.title}» у вас уже ${days} дн. ` +
            'Если дочитали — самое время вернуть её владельцу 🙂',
          { reply_markup: kb },
        ),
      )
    }
    await track(
      opts.send(
        String(loan.ownerTg),
        `📕 Ваша книга «${loan.title}» у @${loan.holderUsername ?? 'читателя'} уже ${days} дн.` +
          (loan.holderTg ? '\nЯ напомнил читателю.' : `\nЧитатель пока не в боте: ${link}`),
        { reply_markup: kb, link_preview_options: { is_disabled: true } },
      ),
    )
    await markReminded(loan.id)
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
  }
  return { loans: loans.length, sent, failed }
}

/** Сколько дней книга на руках. */
export const daysOut = (takenAt: Date, now = new Date()) =>
  Math.max(0, Math.floor((now.getTime() - takenAt.getTime()) / day))

/**
 * Настроение выдачи — чтобы одним взглядом понимать, где всё спокойно,
 * а куда пора написать. Шкала по времени на руках, а если владелец назначил
 * срок и он прошёл — настроение портится быстрее.
 *
 *   0–7 дней   🙂 читают
 *   8–30 дней  📖 всё идёт своим чередом
 *   31–60      😐 стоит напомнить
 *   61–120     😟 давно у читателя
 *   больше     😢 книга загостилась
 */
export type Mood = {
  level: 0 | 1 | 2 | 3 | 4
  emoji: string
  label: string
  days: number
  overdueDays: number
}

export function loanMood(takenAt: Date, dueAt: Date | null, now = new Date()): Mood {
  const days = daysOut(takenAt, now)
  const overdueDays = dueAt ? Math.max(0, Math.floor((now.getTime() - dueAt.getTime()) / day)) : 0

  let level: Mood['level'] = days <= 7 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 120 ? 3 : 4
  // просрочка своего срока весит не меньше календаря: неделя сверху — минус балл
  if (overdueDays > 0) {
    const bump = overdueDays <= 7 ? 2 : overdueDays <= 30 ? 3 : 4
    level = Math.max(level, bump) as Mood['level']
  }

  const faces: Record<Mood['level'], { emoji: string; label: string }> = {
    0: { emoji: '🙂', label: 'первая неделя' },
    1: { emoji: '📖', label: 'читают' },
    2: { emoji: '😐', label: 'пора напомнить' },
    3: { emoji: '😟', label: 'давно у читателя' },
    4: { emoji: '😢', label: 'книга загостилась' },
  }
  return { level, ...faces[level], days, overdueDays }
}

export type LoanSummary = {
  active: number
  /** книги с назначенным сроком, который уже прошёл */
  overdue: number
  /** сколько дней у читателя самая давняя книга */
  longestDays: number
  /** общее настроение полки — по худшей книге */
  mood: Mood | null
  longestTitle: string | null
}

export function summarize(
  loans: { title: string; takenAt: Date; dueAt: Date | null }[],
  now = new Date(),
): LoanSummary {
  if (!loans.length) {
    return { active: 0, overdue: 0, longestDays: 0, mood: null, longestTitle: null }
  }
  const withMood = loans.map((l) => ({ loan: l, mood: loanMood(l.takenAt, l.dueAt, now) }))
  const worst = withMood.reduce((a, b) =>
    b.mood.level > a.mood.level || (b.mood.level === a.mood.level && b.mood.days > a.mood.days) ? b : a,
  )
  return {
    active: loans.length,
    overdue: withMood.filter((x) => x.mood.overdueDays > 0).length,
    longestDays: Math.max(...withMood.map((x) => x.mood.days)),
    mood: worst.mood,
    longestTitle: worst.loan.title,
  }
}

/** Выдача с посчитанными днями и настроением — так её отдаём наружу. */
export const decorate = <T extends { takenAt: Date; dueAt: Date | null }>(loan: T) => ({
  ...loan,
  mood: loanMood(loan.takenAt, loan.dueAt),
})
