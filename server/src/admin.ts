/**
 * Опознание человека для админских команд и карточка «кто это».
 *
 * Зачем. Все команды модерации (`/restrict`, `/ban`, `/unrestrict`, `/unban`)
 * принимали ТОЛЬКО числовой tgId — а взять его админу было негде: в интерфейсе
 * Telegram числовых id нет, в карточках проекта их намеренно не показывают
 * (см. privacy.ts). Получалось право, которым нельзя воспользоваться: наказать
 * можно было лишь того, чей id уже где-то попался.
 *
 * Здесь опознание по нику, по числовому id и по ответу на сообщение — плюс
 * карточка человека, чтобы решение принималось не вслепую.
 *
 * Приватность не ослаблена: это админский путь, ручки для участников по-прежнему
 * не отдают ни tgId, ни чужие ники (privacy.ts). Ник ищется среди тех, кто уже
 * есть в проекте, — справочника «все пользователи Telegram» тут нет.
 */
import { prisma } from './db.js'
import { normHandle } from './notion.js'
import { activeRestrictions, SCOPE_TITLES, type RestrictScope } from './moderation.js'
import { isAdmin } from './env.js'

export type FoundPerson = {
  tgId: bigint
  username: string | null
  firstName: string | null
  city: string | null
  accountStatus: string
  banReason: string | null
}

/**
 * Ищет человека по «@ник», «ник» или числовому id.
 *
 * Ник сначала ищется среди пользователей бота, потом среди библиотекарей
 * (там он мог остаться из Notion, а бота человек ещё не открывал — тогда
 * tgId у записи нет, и опознать его нечем: об этом и сообщаем отдельно).
 */
export async function findPerson(input: string): Promise<
  | { ok: true; person: FoundPerson }
  | { ok: false; code: 'empty' | 'not_found' | 'known_but_no_tg'; name?: string }
> {
  const raw = input.trim()
  if (!raw) return { ok: false, code: 'empty' }

  if (/^\d+$/.test(raw)) {
    const byId = await prisma.user.findUnique({ where: { tgId: BigInt(raw) } })
    // человека может не быть в базе, но id всё равно годится для решения:
    // отдаём заготовку, чтобы команда не отказывала на ровном месте
    return {
      ok: true,
      person: byId
        ? toPerson(byId)
        : {
            tgId: BigInt(raw),
            username: null,
            firstName: null,
            city: null,
            accountStatus: 'active',
            banReason: null,
          },
    }
  }

  const nick = normHandle(raw)
  if (!nick) return { ok: false, code: 'empty' }

  const user = await prisma.user.findFirst({
    where: { username: { equals: nick } },
  })
  if (user) return { ok: true, person: toPerson(user) }

  // ник в базе пользователей мог сохраниться в другом регистре
  const anyCase = await prisma.user.findMany({
    where: { username: { not: null } },
    select: { tgId: true, username: true, firstName: true, city: true, accountStatus: true, banReason: true },
    take: 5000,
  })
  const hit = anyCase.find((u) => normHandle(u.username ?? '') === nick)
  if (hit) return { ok: true, person: toPerson(hit) }

  const lib = await prisma.librarian.findFirst({
    where: { telegramNorm: nick, mergedIntoId: null },
    select: { name: true, tgId: true, city: true },
  })
  if (lib?.tgId) {
    const u = await prisma.user.findUnique({ where: { tgId: lib.tgId } })
    return {
      ok: true,
      person: u
        ? toPerson(u)
        : {
            tgId: lib.tgId,
            username: nick,
            firstName: lib.name,
            city: lib.city,
            accountStatus: 'active',
            banReason: null,
          },
    }
  }
  if (lib) return { ok: false, code: 'known_but_no_tg', name: lib.name }

  return { ok: false, code: 'not_found' }
}

function toPerson(u: {
  tgId: bigint
  username: string | null
  firstName: string | null
  city: string | null
  accountStatus?: string
  banReason?: string | null
}): FoundPerson {
  return {
    tgId: u.tgId,
    username: u.username ?? null,
    firstName: u.firstName ?? null,
    city: u.city ?? null,
    accountStatus: u.accountStatus ?? 'active',
    banReason: u.banReason ?? null,
  }
}

export type PersonCard = {
  person: FoundPerson
  isAdmin: boolean
  librarian: { name: string; city: string | null; books: number } | null
  loansGiven: number
  loansTaken: number
  reviews: number
  restrictions: { scope: RestrictScope; title: string; reason: string; until: Date | null }[]
}

/** Всё, что нужно знать перед решением: кто это, что он делал, что ему уже закрыли. */
export async function personCard(person: FoundPerson, now = new Date()): Promise<PersonCard> {
  const [lib, loansGiven, loansTaken, reviews, restrictions] = await Promise.all([
    prisma.librarian.findFirst({
      where: { tgId: person.tgId, mergedIntoId: null },
      select: { id: true, name: true, city: true },
    }),
    prisma.loan.count({ where: { ownerTg: person.tgId } }),
    prisma.loan.count({ where: { holderTg: person.tgId } }),
    prisma.review.count({ where: { authorTg: person.tgId } }),
    activeRestrictions(person.tgId, now),
  ])

  const books = lib
    ? await prisma.book.count({ where: { ownerId: lib.id, active: true, reviewStatus: 'approved' } })
    : 0

  return {
    person,
    isAdmin: isAdmin(person.tgId),
    librarian: lib ? { name: lib.name, city: lib.city, books } : null,
    loansGiven,
    loansTaken,
    reviews,
    restrictions: restrictions.map((r) => ({
      scope: r.scope as RestrictScope,
      title: SCOPE_TITLES[r.scope as RestrictScope] ?? r.scope,
      reason: r.reason,
      until: r.expiresAt,
    })),
  }
}

/** Короткая сводка проекта для команды: что происходит и на что смотреть. */
export async function projectStats(now = new Date()) {
  const day = 86_400_000
  const [
    books,
    librarians,
    activeLoans,
    overdueLoans,
    waiting,
    reviews,
    pendingBooks,
    hiddenReviews,
    restrictions,
    banned,
    events,
    market,
    newBooksWeek,
    stuckNotices,
  ] = await Promise.all([
    prisma.book.count({ where: { active: true, reviewStatus: 'approved' } }),
    prisma.librarian.count({ where: { mergedIntoId: null } }),
    prisma.loan.count({ where: { status: 'active' } }),
    prisma.loan.count({ where: { status: 'active', dueAt: { lt: now } } }),
    prisma.waiting.count({ where: { status: 'waiting' } }),
    prisma.review.count({ where: { status: 'visible' } }),
    prisma.book.count({ where: { reviewStatus: 'pending' } }),
    prisma.review.count({ where: { status: 'hidden' } }),
    prisma.userRestriction.count({ where: { liftedAt: null } }),
    prisma.user.count({ where: { accountStatus: 'banned' } }),
    prisma.event.count({ where: { startsAt: { gte: now }, removedAt: null } }),
    prisma.marketItem.count({ where: { status: 'active' } }),
    prisma.book.count({
      where: { active: true, reviewStatus: 'approved', createdAt: { gte: new Date(now.getTime() - 7 * day) } },
    }),
    prisma.notificationOutbox.count({ where: { sentAt: null, attempts: { gte: 3 } } }),
  ])

  return {
    books,
    librarians,
    activeLoans,
    overdueLoans,
    waiting,
    reviews,
    pendingBooks,
    hiddenReviews,
    restrictions,
    banned,
    events,
    market,
    newBooksWeek,
    stuckNotices,
  }
}
