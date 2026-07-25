/**
 * «У кого моя книга сейчас».
 *
 * Владелец отмечает: название + ник человека, которому отдал. Дальше бот ведёт
 * учёт сам: карточка книги на полке становится «на руках», через месяц (или к
 * своему сроку) прилетает вежливое напоминание обеим сторонам, а вернуть книгу
 * можно одной кнопкой — с любой стороны.
 *
 * Тонкость Telegram: боту нельзя написать первым тому, кто с ним не общался.
 * Поэтому у выдачи есть ссылка-приглашение `?start=loan_<токен>` — владелец
 * пересылает её, читатель открывает, и с этого момента напоминания доходят.
 *
 * Токен — не id выдачи (тот публичен и предсказуем: возвращается всеми
 * ручками API, светится в событиях и синке). Раньше ссылка была буквально
 * `?start=loan_<id выдачи>`, а claimLoans() при ЛЮБОМ /start (даже без
 * ссылки) подхватывал ВСЕ чужие невостребованные выдачи, у которых
 * holderUsername совпал с ником зашедшего — не только ту, по ссылке которой
 * пришли. Кто угодно, зарегистрировав в Telegram чужой (реальный или
 * распространённый) ник, простым /start присваивал себе все его невостребованные
 * выдачи по всей библиотеке. Теперь: непредсказуемый одноразовый токен на
 * КОНКРЕТНУЮ выдачу, в базе — только его хэш, привязка — только по этому
 * токену (см. issueClaimToken/claimLoanByToken).
 */
import { createHash, randomBytes } from 'node:crypto'
import { prisma } from './db.js'
import { tgHandle } from './notion.js'
import { archiveRow, notionWriteEnabled } from './notion-write.js'
import { invalidateFacets } from './search.js'

/** Срок по умолчанию — месяц: столько обычно и держат книгу. */
const DEFAULT_DAYS = 30

/** Токен живёт с запасом на срок выдачи + недельный цикл напоминаний. */
const CLAIM_TOKEN_TTL_MS = 45 * 86_400_000

const hashClaimToken = (token: string) => createHash('sha256').update(token).digest('hex')

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

  // читателя ещё не знаем — понадобится ссылка-приглашение с одноразовым токеном
  const claimToken = known?.tgId ? null : randomBytes(24).toString('base64url')
  const claimTokenHash = claimToken ? hashClaimToken(claimToken) : null
  const claimTokenExpiresAt = claimToken ? new Date(Date.now() + CLAIM_TOKEN_TTL_MS) : null

  // Всё, что зависит от состояния книги, — в транзакции: иначе между проверкой и
  // пометкой busy книгу мог занять кто-то ещё, а bookId из тела запроса нельзя
  // принимать на веру (иначе выдачей можно пометить занятой ЧУЖУЮ книгу).
  const loan = await prisma.$transaction(async (tx) => {
    if (d.bookId) {
      const book = await tx.book.findUnique({
        where: { id: d.bookId },
        include: { owner: { select: { tgId: true } } },
      })
      if (!book || !book.active) throw new Error('book_not_found')
      // выдавать со своей полки может только владелец книги
      if (book.owner?.tgId == null || book.owner.tgId !== d.ownerTg) throw new Error('not_your_book')
      if (book.reviewStatus !== 'approved') throw new Error('book_not_approved')
      // уже на руках — второй активной выдачи быть не может
      const busy = await tx.loan.findFirst({
        where: { bookId: d.bookId, status: 'active' },
        select: { id: true },
      })
      if (busy || book.status !== 'free') throw new Error('book_busy')
    }
    const created = await tx.loan.create({
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
        claimTokenHash,
        claimTokenExpiresAt,
      },
      include: { book: true },
    })
    // на полке книга помечается занятой, чтобы её не искали зря
    if (created.bookId) {
      await tx.book.update({ where: { id: created.bookId }, data: { status: 'busy' } })
    }
    return created
  })

  await logLoanEvent(loan.id, 'created', d.ownerTg)
  // сырой токен существует только здесь, в памяти, — в базе только его хэш
  return { ...loan, claimToken }
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
  // Возврат и разблокировка книги — одна транзакция: иначе при обрыве процесса
  // между двумя отдельными операциями выдача уже 'returned', а книга навсегда
  // остаётся 'busy' без единой активной выдачи — осиротевшее состояние.
  const result = await prisma.$transaction(async (tx) => {
    const loan = await tx.loan.findUnique({ where: { id } })
    if (!loan) return null
    // закрыть выдачу может владелец или сам читатель
    if (loan.ownerTg !== byTg && loan.holderTg !== byTg) return null

    const updated = await tx.loan.update({
      where: { id },
      data: { status: 'returned', returnedAt: new Date() },
      include: { book: true },
    })

    let archiveNotionId: string | null = null
    if (updated.bookId) {
      const stillOut = await tx.loan.count({
        where: { bookId: updated.bookId, status: 'active' },
      })
      if (!stillOut) {
        const book = await tx.book.findUnique({ where: { id: updated.bookId } })
        // владелец просил скрыть книгу после возврата — мягко удаляем её сейчас
        if (book?.hideAfterReturn) {
          await tx.book.update({
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
          if (book.notionId && notionWriteEnabled()) archiveNotionId = book.notionId
        } else {
          await tx.book.update({ where: { id: updated.bookId }, data: { status: 'free' } })
        }
      }
    }
    return { updated, archiveNotionId }
  })
  if (!result) return null

  await logLoanEvent(id, 'returned', byTg)
  if (result.archiveNotionId) {
    invalidateFacets()
    // внешний вызов в Notion — намеренно вне транзакции, откатывать тут нечего
    await archiveRow(result.archiveNotionId).catch(() => {})
  }
  return result.updated
}

/**
 * Выпускает свежий одноразовый claim-токен для выдачи (для напоминаний —
 * токен из создания уже не восстановить, хэш необратим, поэтому каждое
 * напоминание, где читатель ещё не в боте, чеканит новый). Старый токен, если
 * был, этим же перестаёт работать — это осознанно: одна ссылка действует
 * одновременно, свежая делает предыдущие копии (в старых сообщениях) неактивными.
 */
export async function issueClaimToken(loanId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url')
  await prisma.loan.update({
    where: { id: loanId },
    data: { claimTokenHash: hashClaimToken(token), claimTokenExpiresAt: new Date(Date.now() + CLAIM_TOKEN_TTL_MS) },
  })
  return token
}

export type ClaimResult =
  | { status: 'claimed'; loanId: string }
  | { status: 'already_claimed' }
  | { status: 'username_mismatch'; loanId: string; expectedUsername: string | null }
  | { status: 'expired' }
  | { status: 'not_found' }

/**
 * Привязывает читателя к ОДНОЙ конкретной выдаче по токену из ссылки-
 * приглашения. Никогда не подхватывает другие выдачи по совпадению ника —
 * см. комментарий в шапке файла про исходную уязвимость. `payload` — то, что
 * пришло после `loan_` в `/start`: сначала пробуем как токен (новые выдачи),
 * при неудаче — как raw id для обратной совместимости со старыми ссылками,
 * отправленными до этой защиты (только если у выдачи токена не было и ЛИБО
 * совпадает ник — иначе никакого auto-claim).
 */
export async function claimLoanByToken(
  tgId: bigint,
  usernameRaw: string | null | undefined,
  payload: string | undefined,
): Promise<ClaimResult> {
  if (!payload) return { status: 'not_found' }
  const username = usernameRaw?.toLowerCase() ?? null

  const byToken = await prisma.loan.findUnique({ where: { claimTokenHash: hashClaimToken(payload) } })
  if (byToken) {
    if (byToken.status !== 'active') return { status: 'not_found' }
    if (byToken.holderTg) {
      // тот же человек повторно открыл свою же ссылку — не ошибка, просто повтор
      return byToken.holderTg === tgId ? { status: 'claimed', loanId: byToken.id } : { status: 'already_claimed' }
    }
    if (byToken.claimTokenExpiresAt && byToken.claimTokenExpiresAt.getTime() < Date.now()) {
      return { status: 'expired' }
    }
    const expected = byToken.holderUsername?.toLowerCase() ?? null
    if (expected && username && expected !== username) {
      return { status: 'username_mismatch', loanId: byToken.id, expectedUsername: byToken.holderUsername }
    }
    // Хэш намеренно НЕ гасим здесь: holderTg уже занят этим tgId, так что
    // токен больше никого другого не привяжет (см. проверку выше) — а вот
    // сам обладатель должен иметь возможность повторно открыть ту же ссылку
    // (Telegram не удаляет старые сообщения) и снова увидеть карточку книги.
    await prisma.loan.update({ where: { id: byToken.id }, data: { holderTg: tgId } })
    await logLoanEvent(byToken.id, 'claimed', tgId)
    return { status: 'claimed', loanId: byToken.id }
  }

  // legacy: ссылка вида ?start=loan_<id>, разосланная до введения токенов.
  // Только для выдач, у которых токена никогда не было (новую так не подобрать
  // случайным id), и только при совпадении ника — иначе не привязываем.
  if (username) {
    const legacy = await prisma.loan.findFirst({
      where: { id: payload, holderTg: null, status: 'active', claimTokenHash: null },
    })
    if (legacy && legacy.holderUsername?.toLowerCase() === username) {
      await prisma.loan.update({ where: { id: legacy.id }, data: { holderTg: tgId } })
      await logLoanEvent(legacy.id, 'claimed', tgId)
      return { status: 'claimed', loanId: legacy.id }
    }
  }
  return { status: 'not_found' }
}

/**
 * Отменить возврат (undo): в окне 24 ч и только если книгу за это время не
 * выдали кому-то ещё. Возвращает обновлённую выдачу либо код ошибки.
 */
export async function reopenLoan(id: string, byTg: bigint) {
  // Проверка «книгу не выдали кому-то ещё» и сама реактивация — в одной
  // транзакции: иначе между чтением relent-счётчика и записью status='active'
  // могла проскочить чужая createLoan на ту же книгу — и обе выдачи оказались
  // бы активны одновременно (см. concurrent-тест).
  const result = await prisma.$transaction(async (tx) => {
    const loan = await tx.loan.findUnique({ where: { id }, include: { book: true } })
    if (!loan) return { error: 'not_found' as const }
    if (loan.ownerTg !== byTg && loan.holderTg !== byTg) return { error: 'forbidden' as const }
    if (loan.status !== 'returned') return { error: 'not_returned' as const }
    if (!loan.returnedAt || Date.now() - loan.returnedAt.getTime() > UNDO_WINDOW_MS) {
      return { error: 'too_late' as const }
    }
    if (loan.bookId) {
      const relent = await tx.loan.count({
        where: { bookId: loan.bookId, status: 'active', id: { not: id } },
      })
      if (relent) return { error: 'book_relent' as const }
      const book = await tx.book.findUnique({ where: { id: loan.bookId } })
      if (book?.active) await tx.book.update({ where: { id: loan.bookId }, data: { status: 'busy' } })
    }
    const updated = await tx.loan.update({
      where: { id },
      data: { status: 'active', returnedAt: null },
      include: { book: true },
    })
    return { loan: updated }
  })
  if ('loan' in result) await logLoanEvent(id, 'reopened', byTg)
  return result
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
    // токен из создания не восстановить (в базе только его хэш) — чеканим
    // свежий прямо для этого напоминания; предыдущий (если был) этим гасится
    const link = loan.holderTg
      ? ''
      : `https://t.me/${opts.botUsername}?start=loan_${await issueClaimToken(loan.id)}`

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
