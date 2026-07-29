/**
 * Права участника и решения модераторов.
 *
 * Здесь одна проверка на весь проект: `assertUserCan`. Разложить её по ручкам
 * и командам нельзя — стоит забыть одно место, и ограничение перестаёт что-либо
 * значить. Кнопка, спрятанная в приложении, защитой не считается вовсе: бот и
 * API принимают тот же запрос напрямую.
 *
 * Два разных механизма:
 *   — `User.accountStatus = 'banned'` — человек не начинает НИЧЕГО нового;
 *   — `UserRestriction` — точечный запрет на одно действие (например, отзывы),
 *     со сроком и с историей. «Ограничен» отдельным полем не хранится: это
 *     вычисляется по действующим ограничениям, иначе появится второй источник
 *     правды.
 *
 * Что НЕ ограничивается никогда (осознанно):
 *   — возврат книги: он закрывает обязательство перед другим человеком, и
 *     наказывать им вторую сторону нельзя;
 *   — «Ваши данные»: выгрузка и удаление работают и у заблокированного, иначе
 *     блокировка превращалась бы в удержание чужих данных.
 */
import { prisma } from './db.js'
import { isAdmin } from './env.js'

/** Действия, которые можно закрыть человеку по отдельности. */
export const SCOPES = ['add_books', 'reviews', 'reports', 'waitlist', 'market', 'ai'] as const
export type Scope = (typeof SCOPES)[number]
/** Особый scope: закрывает всё сразу, но это НЕ бан (аккаунт остаётся живым). */
export const SCOPE_ALL = 'all'
export type RestrictScope = Scope | typeof SCOPE_ALL

export const isScope = (v: string): v is RestrictScope =>
  v === SCOPE_ALL || (SCOPES as readonly string[]).includes(v)

/** Человеческие названия — для писем человеку и для админских карточек. */
export const SCOPE_TITLES: Record<RestrictScope, string> = {
  add_books: 'добавление книг',
  reviews: 'оценки и отзывы',
  reports: 'жалобы на отзывы',
  waitlist: 'очереди на книги',
  market: 'барахолка',
  ai: 'подбор книги',
  all: 'все действия в проекте',
}

export type Verdict =
  | { allowed: true }
  | { allowed: false; code: 'banned'; reason: string | null }
  | { allowed: false; code: 'restricted'; scope: RestrictScope; reason: string; until: Date | null }

/** Действующие ограничения человека: не снятые и не истёкшие. */
export async function activeRestrictions(tgId: bigint, now = new Date()) {
  return prisma.userRestriction.findMany({
    where: {
      userTg: tgId,
      liftedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: 'desc' },
  })
}

/**
 * Может ли человек выполнить действие. Возвращает вердикт, а не бросает
 * исключение: вызывающему нужно объяснить человеку причину, а не просто отказать.
 */
export async function checkUserCan(
  tgId: bigint,
  scope: Scope,
  now = new Date(),
): Promise<Verdict> {
  const user = await prisma.user.findUnique({
    where: { tgId },
    select: { accountStatus: true, banReason: true },
  })
  if (user?.accountStatus === 'banned') {
    return { allowed: false, code: 'banned', reason: user.banReason }
  }

  const rows = await activeRestrictions(tgId, now)
  const hit = rows.find((r) => r.scope === scope || r.scope === SCOPE_ALL)
  if (!hit) return { allowed: true }
  return {
    allowed: false,
    code: 'restricted',
    scope: hit.scope as RestrictScope,
    reason: hit.reason,
    until: hit.expiresAt,
  }
}

export class NotAllowedError extends Error {
  constructor(readonly verdict: Exclude<Verdict, { allowed: true }>) {
    super(verdict.code)
  }
}

/** То же самое, но исключением — для мест, где отказ прерывает работу. */
export async function assertUserCan(tgId: bigint, scope: Scope, now = new Date()) {
  const v = await checkUserCan(tgId, scope, now)
  if (!v.allowed) throw new NotAllowedError(v)
}

/** «30 июля 2026» — без «г.» на конце, иначе в тексте получается «2026 г..». */
const dateRu = (d: Date) =>
  d
    .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    .replace(/\s*г\.?$/, '')

/** Отказ человеческим языком. Кто пожаловался — не раскрываем никогда. */
export function explainVerdict(v: Exclude<Verdict, { allowed: true }>): string {
  if (v.code === 'banned') {
    return [
      'Ваш доступ к проекту закрыт.',
      v.reason ? `Причина: ${v.reason}.` : '',
      'Свои данные вы по-прежнему можете выгрузить и удалить на экране «Ваши данные».',
    ]
      .filter(Boolean)
      .join(' ')
  }
  const what = SCOPE_TITLES[v.scope]
  const until = v.until ? `Ограничение действует до ${dateRu(v.until)}.` : 'Ограничение бессрочное.'
  return `Сейчас вам недоступно: ${what}. Причина: ${v.reason}. ${until}`
}

/* ── решения модераторов ──────────────────────────────────── */

/**
 * Как сообщить человеку о решении. Регистрирует бот (единственный, кто умеет
 * писать в Telegram); API и команды зовут одно и то же, поэтому человек
 * получает одинаковый текст независимо от того, откуда пришло решение.
 */
type NoticeSender = (tgId: bigint, text: string) => void | Promise<void>
let noticeSender: NoticeSender | null = null
export const setModerationNoticeSender = (fn: NoticeSender) => {
  noticeSender = fn
}

export async function notifyModerated(tgId: bigint, text: string) {
  if (!noticeSender) return
  await Promise.resolve(noticeSender(tgId, text)).catch((e: any) =>
    console.error('[moderation] не удалось сообщить человеку:', e?.message ?? e),
  )
}

export type ModerationResult<T extends string> =
  | { ok: true; notice: string; action: string }
  | { ok: false; code: T }

/** Запись в неизменяемый журнал. Отдельной функцией, чтобы её нельзя было забыть. */
export async function logModeration(entry: {
  actorTg: bigint
  targetUserTg?: bigint | null
  targetType: 'user' | 'review' | 'book' | 'market'
  targetId?: string | null
  action: string
  reason: string
  meta?: unknown
}) {
  return prisma.moderationAction.create({
    data: {
      actorTg: entry.actorTg,
      targetUserTg: entry.targetUserTg ?? null,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      action: entry.action,
      reason: entry.reason,
      meta: entry.meta === undefined ? null : JSON.stringify(entry.meta),
    },
  })
}

/**
 * Ограничить одно действие.
 *
 * Идемпотентно: повторное нажатие по тому же scope не заводит второе
 * ограничение, не пишет второе решение в журнал и не шлёт второе письмо.
 */
export async function restrictUser(opts: {
  actorTg: bigint
  targetTg: bigint
  scope: RestrictScope
  reason: string
  days?: number | null
  now?: Date
}): Promise<ModerationResult<'no_reason' | 'already_restricted' | 'unknown_user' | 'self'>> {
  const now = opts.now ?? new Date()
  if (!opts.reason.trim()) return { ok: false, code: 'no_reason' }
  if (opts.actorTg === opts.targetTg) return { ok: false, code: 'self' }

  const user = await prisma.user.findUnique({ where: { tgId: opts.targetTg } })
  if (!user) return { ok: false, code: 'unknown_user' }

  const expiresAt = opts.days ? new Date(now.getTime() + opts.days * 86_400_000) : null

  // проверка и запись — одной транзакцией: два админа могут нажать кнопку
  // одновременно, и раздельные запросы дали бы ДВА ограничения на одно и то же
  // (поймано тестом на параллельные решения). Частичный уникальный индекс
  // «одно действующее ограничение на scope» в схеме Prisma не выразить, поэтому
  // сериализуем здесь
  const created = await prisma.$transaction(async (tx) => {
    const existing = await tx.userRestriction.findFirst({
      where: {
        userTg: opts.targetTg,
        scope: opts.scope,
        liftedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    })
    if (existing) return false
    await tx.userRestriction.create({
      data: {
        userTg: opts.targetTg,
        scope: opts.scope,
        reason: opts.reason.trim().slice(0, 300),
        createdByTg: opts.actorTg,
        createdAt: now,
        expiresAt,
      },
    })
    return true
  })
  if (!created) return { ok: false, code: 'already_restricted' }

  await logModeration({
    actorTg: opts.actorTg,
    targetUserTg: opts.targetTg,
    targetType: 'user',
    action: 'restrict',
    reason: opts.reason.trim().slice(0, 300),
    meta: { scope: opts.scope, days: opts.days ?? null },
  })

  const until = expiresAt ? `до ${dateRu(expiresAt)}` : 'бессрочно'
  return {
    ok: true,
    action: 'restrict',
    notice: [
      `Вам временно закрыто: ${SCOPE_TITLES[opts.scope]} (${until}).`,
      `Причина: ${opts.reason.trim()}.`,
      'Остальным в проекте вы пользуетесь как обычно.',
      'Если считаете решение ошибкой, напишите админам проекта.',
    ].join('\n'),
  }
}

/** Снять ограничение. Само ограничение не удаляется: история решений остаётся. */
export async function unrestrictUser(opts: {
  actorTg: bigint
  targetTg: bigint
  scope: RestrictScope
  reason: string
  now?: Date
}): Promise<ModerationResult<'not_restricted' | 'no_reason'>> {
  const now = opts.now ?? new Date()
  if (!opts.reason.trim()) return { ok: false, code: 'no_reason' }
  const rows = (await activeRestrictions(opts.targetTg, now)).filter((r) => r.scope === opts.scope)
  if (!rows.length) return { ok: false, code: 'not_restricted' }

  await prisma.userRestriction.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { liftedAt: now, liftedByTg: opts.actorTg },
  })
  // снятие чужого решения — тоже решение, и оно тоже попадает в журнал
  await logModeration({
    actorTg: opts.actorTg,
    targetUserTg: opts.targetTg,
    targetType: 'user',
    action: 'unrestrict',
    reason: opts.reason.trim().slice(0, 300),
    meta: { scope: opts.scope, lifted: rows.length },
  })
  return {
    ok: true,
    action: 'unrestrict',
    notice: `Ограничение снято: ${SCOPE_TITLES[opts.scope]} снова доступно.`,
  }
}

/**
 * Заблокировать аккаунт целиком.
 *
 * Себя и админов блокировать нельзя: иначе проект остаётся без модераторов
 * из-за одного неверного нажатия. Автоматики здесь нет намеренно — три жалобы
 * прячут отзыв, но человека блокирует только человек.
 */
export async function banUser(opts: {
  actorTg: bigint
  targetTg: bigint
  reason: string
  now?: Date
}): Promise<ModerationResult<'no_reason' | 'already_banned' | 'unknown_user' | 'self' | 'admin'>> {
  const now = opts.now ?? new Date()
  if (!opts.reason.trim()) return { ok: false, code: 'no_reason' }
  if (opts.actorTg === opts.targetTg) return { ok: false, code: 'self' }
  if (isAdmin(opts.targetTg)) return { ok: false, code: 'admin' }

  // проверка «уже заблокирован» и сама блокировка — одной транзакцией, иначе
  // два одновременных нажатия дадут две записи в журнале и два письма человеку
  const banned = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { tgId: opts.targetTg } })
    if (!user) return 'unknown_user' as const
    if (user.accountStatus === 'banned') return 'already_banned' as const
    await tx.user.update({
      where: { tgId: opts.targetTg },
      data: {
        accountStatus: 'banned',
        bannedAt: now,
        bannedByTg: opts.actorTg,
        banReason: opts.reason.trim().slice(0, 300),
      },
    })
    return 'ok' as const
  })
  if (banned !== 'ok') return { ok: false, code: banned }
  await logModeration({
    actorTg: opts.actorTg,
    targetUserTg: opts.targetTg,
    targetType: 'user',
    action: 'ban',
    reason: opts.reason.trim().slice(0, 300),
  })
  return {
    ok: true,
    action: 'ban',
    notice: [
      'Ваш доступ к проекту закрыт.',
      `Причина: ${opts.reason.trim()}.`,
      'Свои данные вы по-прежнему можете выгрузить и удалить на экране «Ваши данные».',
      'Если считаете решение ошибкой, напишите админам проекта.',
    ].join('\n'),
  }
}

export async function unbanUser(opts: {
  actorTg: bigint
  targetTg: bigint
  reason: string
}): Promise<ModerationResult<'not_banned' | 'no_reason' | 'unknown_user'>> {
  if (!opts.reason.trim()) return { ok: false, code: 'no_reason' }
  const user = await prisma.user.findUnique({ where: { tgId: opts.targetTg } })
  if (!user) return { ok: false, code: 'unknown_user' }
  if (user.accountStatus !== 'banned') return { ok: false, code: 'not_banned' }

  await prisma.user.update({
    where: { tgId: opts.targetTg },
    data: { accountStatus: 'active', bannedAt: null, bannedByTg: null, banReason: null },
  })
  await logModeration({
    actorTg: opts.actorTg,
    targetUserTg: opts.targetTg,
    targetType: 'user',
    action: 'unban',
    reason: opts.reason.trim().slice(0, 300),
  })
  return { ok: true, action: 'unban', notice: 'Доступ к проекту восстановлен.' }
}

/* ── очередь разбора ──────────────────────────────────────── */

export type QueueReview = {
  id: string
  workKey: string
  rating: number
  text: string | null
  status: string
  authorTg: string
  authorName: string | null
  reports: number
  reportedAt: string[]
  hiddenAt: string | null
  /** прошлые решения по этому же отзыву: контекст для модератора */
  history: { action: string; reason: string; at: string }[]
}

/**
 * Что ждёт разбора. Собирается одним местом, чтобы бот и API показывали
 * одинаковое, а не два похожих списка.
 */
export async function moderationQueue(now = new Date()) {
  const reviews = await prisma.review.findMany({
    where: { OR: [{ status: 'hidden' }, { reportRows: { some: {} } }] },
    include: {
      author: { select: { tgId: true, firstName: true } },
      reportRows: { orderBy: { createdAt: 'asc' } },
    },
    orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    take: 50,
  })
  const ids = reviews.map((r) => r.id)
  const history = ids.length
    ? await prisma.moderationAction.findMany({
        where: { targetType: 'review', targetId: { in: ids } },
        orderBy: { createdAt: 'desc' },
      })
    : []

  const [pendingBooks, restrictions, banned, recent] = await Promise.all([
    prisma.book.count({ where: { reviewStatus: 'pending' } }),
    prisma.userRestriction.findMany({
      where: { liftedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.user.findMany({
      where: { accountStatus: 'banned' },
      select: { tgId: true, username: true, firstName: true, bannedAt: true, banReason: true },
      orderBy: { bannedAt: 'desc' },
      take: 50,
    }),
    prisma.moderationAction.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
  ])

  return {
    reviews: reviews.map(
      (r): QueueReview => ({
        id: r.id,
        workKey: r.workKey,
        rating: r.rating,
        text: r.text,
        status: r.status,
        authorTg: String(r.authorTg),
        authorName: r.author?.firstName ?? null,
        // число УНИКАЛЬНЫХ жалоб: строки, а не счётчик (см. reviews.ts)
        reports: r.reportRows.length,
        reportedAt: r.reportRows.map((x) => x.createdAt.toISOString()),
        hiddenAt: r.hiddenAt?.toISOString() ?? null,
        history: history
          .filter((h) => h.targetId === r.id)
          .map((h) => ({ action: h.action, reason: h.reason, at: h.createdAt.toISOString() })),
      }),
    ),
    pendingBooks,
    restrictions: restrictions.map((r) => ({
      id: r.id,
      userTg: String(r.userTg),
      scope: r.scope,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt?.toISOString() ?? null,
    })),
    banned: banned.map((b) => ({
      tgId: String(b.tgId),
      username: b.username,
      firstName: b.firstName,
      bannedAt: b.bannedAt?.toISOString() ?? null,
      reason: b.banReason,
    })),
    recent: recent.map((a) => ({
      action: a.action,
      targetType: a.targetType,
      targetId: a.targetId,
      targetUserTg: a.targetUserTg ? String(a.targetUserTg) : null,
      reason: a.reason,
      at: a.createdAt.toISOString(),
    })),
  }
}

/** Решение по одному отзыву: скрыть, вернуть, удалить или отклонить жалобы. */
export async function decideReview(opts: {
  actorTg: bigint
  reviewId: string
  decision: 'hide' | 'restore' | 'delete' | 'dismiss'
  reason: string
  now?: Date
}): Promise<
  ModerationResult<'not_found' | 'no_reason' | 'already_hidden' | 'already_visible'>
> {
  const now = opts.now ?? new Date()
  const needsReason = opts.decision === 'hide' || opts.decision === 'delete'
  if (needsReason && !opts.reason.trim()) return { ok: false, code: 'no_reason' }

  const review = await prisma.review.findUnique({ where: { id: opts.reviewId } })
  if (!review) return { ok: false, code: 'not_found' }
  if (opts.decision === 'hide' && review.status === 'hidden') {
    return { ok: false, code: 'already_hidden' }
  }
  if (opts.decision === 'restore' && review.status === 'visible') {
    return { ok: false, code: 'already_visible' }
  }

  const reason = opts.reason.trim().slice(0, 300) || 'без комментария'

  if (opts.decision === 'delete') {
    await prisma.review.delete({ where: { id: opts.reviewId } })
  } else if (opts.decision === 'hide') {
    await prisma.review.update({
      where: { id: opts.reviewId },
      data: { status: 'hidden', hiddenAt: now, hiddenByTg: opts.actorTg },
    })
  } else if (opts.decision === 'restore' || opts.decision === 'dismiss') {
    // «отклонить жалобы» и «вернуть» это одно и то же действие с разным смыслом:
    // отзыв снова виден, накопленные жалобы обнуляются
    await prisma.reviewReport.deleteMany({ where: { reviewId: opts.reviewId } })
    await prisma.review.update({
      where: { id: opts.reviewId },
      data: { status: 'visible', hiddenAt: null, hiddenByTg: null, reports: 0 },
    })
  }

  await logModeration({
    actorTg: opts.actorTg,
    targetUserTg: review.authorTg,
    targetType: 'review',
    targetId: opts.reviewId,
    action: opts.decision,
    reason,
    meta: { workKey: review.workKey },
  })

  const notices: Record<typeof opts.decision, string> = {
    hide: `Ваш отзыв скрыт модератором. Причина: ${reason}.`,
    delete: `Ваш отзыв удалён модератором. Причина: ${reason}.`,
    restore: 'Ваш отзыв снова виден: жалобы на него рассмотрены и отклонены.',
    dismiss: 'Ваш отзыв снова виден: жалобы на него рассмотрены и отклонены.',
  }
  return { ok: true, action: opts.decision, notice: notices[opts.decision] }
}
