/**
 * Дайджест новинок библиотеки: что появилось на полках за сутки и за месяц.
 *
 * Опираемся на `addedAt` — дату добавления в таблицу проекта, а не на момент
 * попадания строки в нашу базу: при первом синке все 3 200 книг «пришли» разом,
 * и по createdAt дайджест был бы бессмысленным.
 */
import { prisma } from './db.js'
import { toCard, type BookCard } from './search.js'

export type DigestPeriod = 'day' | 'month'

const PERIOD_HOURS: Record<DigestPeriod, number> = { day: 24, month: 24 * 30 }

export type Digest = {
  period: DigestPeriod
  since: string
  total: number
  items: BookCard[]
  /** сколько новинок в каждом городе — для короткой сводки */
  byCity: { city: string; count: number }[]
}

export async function digest(
  period: DigestPeriod = 'day',
  city?: string,
  limit = 20,
  now = Date.now(),
): Promise<Digest> {
  const since = new Date(now - PERIOD_HOURS[period] * 3600_000)
  const where = {
    active: true,
    reviewStatus: 'approved',
    /**
     * Новинка — либо по дате из таблицы проекта, либо по тому, когда книга
     * появилась у нас.
     *
     * Одного `addedAt` мало по двум причинам. Первая: в таблице проекта стоит
     * ДАТА без времени, то есть полночь, — книга, добавленная вчера вечером,
     * к утру «старше суток» и в дайджест уже не попадает. Вторая: сверка идёт
     * раз в 12 часов, поэтому книга, добавленная позавчера и подхваченная
     * сегодня, не попала бы в суточный дайджест ВООБЩЕ — ни в тот день, когда
     * её вписали, ни в тот, когда мы её увидели.
     *
     * `createdAt` — момент появления строки в нашей базе. Первый массовый
     * импорт (все 3200 книг разом) давно позади и повториться может только на
     * пустой базе, где дайджест и так никого не удивит.
     */
    OR: [{ addedAt: { gte: since } }, { createdAt: { gte: since } }],
    ...(city ? { city } : {}),
  }

  const [total, rows, grouped] = await Promise.all([
    prisma.book.count({ where }),
    prisma.book.findMany({
      where,
      include: {
        owner: {
          select: { id: true, name: true, telegram: true, instagram: true, city: true, district: true },
        },
      },
      orderBy: [{ addedAt: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    }),
    prisma.book.groupBy({ by: ['city'], _count: true, where }),
  ])

  return {
    period,
    since: since.toISOString(),
    total,
    items: rows.map((b) => toCard(b)),
    byCity: grouped
      .filter((g) => g.city)
      .map((g) => ({ city: g.city!, count: g._count }))
      .sort((a, b) => b.count - a.count),
  }
}
