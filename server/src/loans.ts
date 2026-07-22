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

/** Срок по умолчанию — месяц: столько обычно и держат книгу. */
export const DEFAULT_DAYS = 30

export type LoanDraft = {
  ownerTg: bigint
  title: string
  bookId?: string | null
  holder: string
  holderName?: string | null
  days?: number | null
  note?: string | null
}

const day = 86_400_000

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
  const loan = await prisma.loan.create({
    data: {
      title,
      bookId: d.bookId ?? null,
      ownerTg: d.ownerTg,
      holderUsername,
      holderName: d.holderName ?? known?.firstName ?? null,
      holderTg: known?.tgId ?? null,
      dueAt: days ? new Date(Date.now() + days * day) : null,
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
      await prisma.book.update({ where: { id: updated.bookId }, data: { status: 'free' } })
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
