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

/**
 * Насколько книга из таблицы проекта может отстать от нашей базы и всё ещё
 * считаться новинкой. Сверка идёт раз в 12 часов, но деплой или сбой могут её
 * отложить, поэтому берём трое суток с запасом.
 */
export const SYNC_LAG_MS = 3 * 24 * 3600_000

/**
 * Условие «книга свежая» для запроса. Живёт здесь, рядом с объяснением, и
 * используется и дайджестом, и значком «Новинка» на обложке: правило должно
 * быть одно, иначе подборка и бейдж разойдутся.
 */
export function freshWhere(since: Date) {
  return {
    OR: [
      { addedAt: { gte: since } },
      { createdAt: { gte: since }, addedAt: { gte: new Date(since.getTime() - SYNC_LAG_MS) } },
      // книги без даты в таблице судим только по нашей: другой у них нет
      { createdAt: { gte: since }, addedAt: null },
    ],
  }
}

/** То же правило, но для уже загруженной книги (карточка знает только данные). */
export function isFresh(
  b: { addedAt?: Date | string | null; createdAt?: Date | string | null },
  since: Date,
): boolean {
  const added = b.addedAt ? new Date(b.addedAt) : null
  const created = b.createdAt ? new Date(b.createdAt) : null
  if (added && added >= since) return true
  if (!created || created < since) return false
  // у книги из таблицы проекта дата там должна быть тоже свежей: иначе весь
  // каталог, залитый в базу разом, стал бы «новинками» (см. регрессию 29.07)
  return !added || added >= new Date(since.getTime() - SYNC_LAG_MS)
}

/** Сколько дней книга считается новинкой для значка на обложке. */
export const NEW_BADGE_DAYS = 7

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
     * появилась у нас, но с оглядкой на дату в таблице.
     *
     * Одного `addedAt` мало по двум причинам. Первая: в таблице проекта стоит
     * ДАТА без времени, то есть полночь, — книга, добавленная вчера вечером,
     * к утру «старше суток» и в дайджест уже не попадает. Вторая: сверка идёт
     * раз в 12 часов, поэтому книга, добавленная позавчера и подхваченная
     * сегодня, не попала бы в суточный дайджест ВООБЩЕ — ни в тот день, когда
     * её вписали, ни в тот, когда мы её увидели.
     *
     * Но и одного `createdAt` мало: при первом наполнении базы весь каталог
     * появляется у нас разом. Ровно это и случилось на проде 22 июля — после
     * первой версии этой правки месячный дайджест показал все 3249 книг вместо
     * 81 (поймано прод-смоуком). Поэтому вклад `createdAt` ограничен допуском
     * `SYNC_LAG_MS`: книга считается новинкой, если мы узнали о ней в этот
     * период И в таблице проекта она тоже свежая. Массовый импорт старого
     * каталога через это условие не проходит.
     */
    ...freshWhere(since),
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
