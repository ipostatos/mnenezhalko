/**
 * Сроки хранения: приложение чистит данные само, а не «когда-нибудь руками».
 *
 * Обещание в тексте о приватности («храним 24 месяца») чего-то стоит только
 * если есть код, который это исполняет. Здесь он и живёт: один проход раз в
 * сутки, каждое правило отдельно и с понятным именем.
 *
 * Сроки утверждены владельцем проекта 30.07.2026 и совпадают с таблицей на
 * экране «Ваши данные» (web/src/privacy-text.ts) — при правке менять оба места.
 */
import { prisma } from './db.js'
import { ERASED_NAME } from './mydata.js'

const DAY = 86_400_000

/** Сроки в днях. Вынесены наверх, чтобы правило можно было прочитать целиком. */
export const RETENTION = {
  /** профиль без книг, выдач и очередей, в который давно не заходили */
  idleUserDays: 365,
  /** закрытая выдача: после этого срока обезличиваем участников */
  closedLoanDays: 730,
  /** закрытая (истёкшая, отменённая) запись в очереди */
  closedWaitingDays: 30,
  /** отзыв, скрытый модерацией: даём время на разбор, потом удаляем насовсем */
  hiddenReviewDays: 30,
  /** жалобы на отзыв, который уже давно не скрыт */
  reportDays: 365,
  /** решения модераторов: 12 месяцев после того, как ограничение перестало действовать */
  moderationLogDays: 365,
  /** отправленные письма о решениях: хранить их дальше незачем */
  sentNoticeDays: 30,
} as const

export type RetentionReport = {
  профилей_удалено: number
  выдач_обезличено: number
  очередей_удалено: number
  отзывов_удалено: number
  жалоб_удалено: number
  решений_модерации_удалено: number
  писем_удалено: number
}

const ago = (days: number, now: number) => new Date(now - days * DAY)

/**
 * Один проход чистки. Возвращает сводку — её печатает планировщик.
 *
 * @param now подменяется в тестах: ждать реальные два года мы не будем
 */
export async function applyRetention(now = Date.now()): Promise<RetentionReport> {
  const report: RetentionReport = {
    профилей_удалено: 0,
    выдач_обезличено: 0,
    очередей_удалено: 0,
    отзывов_удалено: 0,
    жалоб_удалено: 0,
    решений_модерации_удалено: 0,
    писем_удалено: 0,
  }

  // 1. Закрытые выдачи старше срока: строка остаётся историей обмена, люди из
  //    неё уходят. Именно обезличивание, а не удаление: на этих строках держится
  //    счётчик «сколько книг обменяли вместе»
  const oldLoans = await prisma.loan.findMany({
    where: {
      status: 'returned',
      returnedAt: { lt: ago(RETENTION.closedLoanDays, now) },
      OR: [{ ownerTg: { not: null } }, { holderTg: { not: null } }, { holderUsername: { not: null } }],
    },
    select: { id: true },
  })
  if (oldLoans.length) {
    const ids = oldLoans.map((l) => l.id)
    await prisma.loan.updateMany({
      where: { id: { in: ids } },
      data: { ownerTg: null, holderTg: null, holderUsername: null, holderName: ERASED_NAME },
    })
    await prisma.loanEvent.updateMany({ where: { loanId: { in: ids } }, data: { byTg: null } })
    report.выдач_обезличено = ids.length
  }

  // 2. Закрытые записи в очереди
  // закрытая запись — это «ушёл сам / протухла» (leftAt) либо «позвали»
  // (notifiedAt); поля времени у них разные, поэтому два условия, а не одно
  const closedBefore = ago(RETENTION.closedWaitingDays, now)
  const waitings = await prisma.waiting.deleteMany({
    where: {
      OR: [
        { status: 'left', leftAt: { lt: closedBefore } },
        { status: 'notified', notifiedAt: { lt: closedBefore } },
        // подстраховка для записей без отметки времени: их возраст считаем от
        // срока годности самой очереди
        { status: { in: ['left', 'notified'] }, leftAt: null, notifiedAt: null, expiresAt: { lt: closedBefore } },
      ],
    },
  })
  report.очередей_удалено = waitings.count

  // 3. Скрытые отзывы: срок на разбор вышел, дальше держать текст незачем
  const hidden = await prisma.review.deleteMany({
    where: { status: 'hidden', hiddenAt: { lt: ago(RETENTION.hiddenReviewDays, now) } },
  })
  report.отзывов_удалено = hidden.count

  // 4. Старые жалобы на отзывы, которые в итоге остались видимыми
  const reports = await prisma.reviewReport.deleteMany({
    where: {
      createdAt: { lt: ago(RETENTION.reportDays, now) },
      review: { status: 'visible' },
    },
  })
  report.жалоб_удалено = reports.count

  // 5. Профили, в которые давно не заходили и за которыми ничего не осталось.
  //    Пустые именно по существу: ни книг, ни выдач с любой стороны, ни очередей,
  //    ни отзывов. Такой профиль хранить нечего и незачем
  const idle = await prisma.user.findMany({
    where: {
      seenAt: { lt: ago(RETENTION.idleUserDays, now) },
      isAdmin: false,
      librarian: null,
      loansGiven: { none: {} },
      loansTaken: { none: {} },
      waitings: { none: {} },
      reviews: { none: {} },
      marketItems: { none: {} },
    },
    select: { tgId: true },
  })
  if (idle.length) {
    const r = await prisma.user.deleteMany({ where: { tgId: { in: idle.map((u) => u.tgId) } } })
    report.профилей_удалено = r.count
  }

  // 6. Журнал модерации: решение хранится год после того, как перестало
  //    действовать. Дольше держать незачем, а раньше нельзя: по нему объясняют
  //    человеку, почему его ограничили, и разбирают спорные случаи
  const logCutoff = ago(RETENTION.moderationLogDays, now)
  const oldLog = await prisma.moderationAction.deleteMany({
    where: { createdAt: { lt: logCutoff } },
  })
  report.решений_модерации_удалено = oldLog.count

  // 7. Отправленные письма о решениях
  const sent = await prisma.notificationOutbox.deleteMany({
    where: { sentAt: { lt: ago(RETENTION.sentNoticeDays, now) } },
  })
  report.писем_удалено = sent.count

  return report
}

/** Ничего не нашлось — в лог пишем короткую строку, а не пустой объект. */
export const describeRetention = (r: RetentionReport): string => {
  const parts = Object.entries(r)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
  return parts.length ? parts.join(', ') : 'чистить нечего'
}
