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
  let claimed = 0
  if (loanId) {
    const { count } = await prisma.loan.updateMany({
      where: { id: loanId, holderTg: null },
      data: { holderTg: tgId },
    })
    claimed += count
  }
  if (username) {
    const { count } = await prisma.loan.updateMany({
      where: { holderUsername: username, holderTg: null, status: 'active' },
      data: { holderTg: tgId },
    })
    claimed += count
  }
  return claimed
}

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

export const markReminded = (id: string) =>
  prisma.loan.update({ where: { id }, data: { remindedAt: new Date() } })

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
