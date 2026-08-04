/**
 * Встречи: показ прошедших админу и снятие их из списка.
 *
 * Обычный список (`/api/events`) отдаёт предстоящие встречи и шестичасовой
 * хвост — встреча, которая идёт прямо сейчас или только что кончилась, из
 * афиши пропадать не должна. Дальше она исчезает из списка сама, но остаётся
 * в базе, и убрать её было нечем: афиша из чата разбирается автоматически, так
 * что мусор (разобралось не то, встречу отменили, дата оказалась прошлогодней)
 * копился без всякого выхода.
 *
 * Правила снятия:
 *  - только прошедшую. Предстоящую встречу снять нельзя вовсе: её уже видят
 *    люди, и случайный жест на экране не должен убирать анонс из афиши;
 *  - мягко: строка остаётся с `removedAt`. Физическое удаление вернуло бы
 *    встречу при повторном импорте темы (дедуп по `sourceMsgId`) и оставило бы
 *    в журнале модерации ссылку в никуда;
 *  - решение пишется в тот же журнал, что и остальная модерация.
 *
 * Письма никому не уходят — в отличие от снятой карточки барахолки, у встречи
 * нет автора-участника, которому надо объясниться: её завёл админ или разобрал
 * бот из афиши в чате.
 */
import { prisma } from './db.js'
import { logModeration } from './moderation.js'

/** Сколько встреча висит в общем списке после начала: идёт — значит показываем. */
export const EVENT_TAIL_MS = 6 * 3600_000

/** Насколько назад админ видит прошедшие встречи: дальше это уже архив. */
export const PAST_WINDOW_DAYS = 60

/** Причина по умолчанию: снятие прошедшей встречи не требует объяснений. */
const DEFAULT_REASON = 'встреча прошла'

/** Прошедшие встречи для админского блока — свежие сверху. */
export function listPastEvents(now = new Date(), city?: string) {
  return prisma.event.findMany({
    where: {
      startsAt: { lt: new Date(now.getTime() - EVENT_TAIL_MS), gte: pastWindowStart(now) },
      removedAt: null,
      ...(city ? { city } : {}),
    },
    orderBy: { startsAt: 'desc' },
    take: 100,
  })
}

export function pastWindowStart(now = new Date()) {
  return new Date(now.getTime() - PAST_WINDOW_DAYS * 86_400_000)
}

/**
 * Снять прошедшую встречу.
 *
 * `not_past` — не ошибка ввода, а граница возможностей: предстоящую встречу
 * этой ручкой не убрать ни свайпом, ни запросом напрямую.
 */
export async function removeEvent(opts: {
  actorTg: bigint
  id: string
  reason?: string
  now?: Date
}): Promise<
  | { ok: true; event: { id: string; title: string; startsAt: Date } }
  | { ok: false; code: 'not_found' | 'not_past' | 'already_removed' }
> {
  const now = opts.now ?? new Date()
  const reason = opts.reason?.trim().slice(0, 300) || DEFAULT_REASON

  const found = await prisma.event.findUnique({ where: { id: opts.id } })
  if (!found) return { ok: false, code: 'not_found' }
  if (found.startsAt.getTime() > now.getTime() - EVENT_TAIL_MS) return { ok: false, code: 'not_past' }

  const outcome = await prisma.$transaction(async (tx) => {
    // условный переход: два админа, нажавшие одновременно, не сделают
    // двух записей в журнале об одном и том же решении
    const changed = await tx.event.updateMany({
      where: { id: found.id, removedAt: null },
      data: { removedAt: now },
    })
    if (!changed.count) return 'already_removed' as const

    await logModeration(tx, {
      actorTg: opts.actorTg,
      targetType: 'event',
      targetId: found.id,
      action: 'remove',
      reason,
      // в журнал кладём то, что и так в самой карточке: по названию и дате
      // решение можно понять через полгода, не поднимая базу
      meta: { title: found.title, city: found.city, startsAt: found.startsAt.toISOString() },
    })
    return 'ok' as const
  })
  if (outcome !== 'ok') return { ok: false, code: outcome }

  return { ok: true, event: { id: found.id, title: found.title, startsAt: found.startsAt } }
}
