/**
 * Значки библиотекаря (issue #11): «первая книга», «полка на десять», «книги
 * ходят» и так далее.
 *
 * Три решения, которые здесь важнее кода:
 *
 * 1. **Считаются на лету из того, что уже есть.** Ни таблиц, ни миграций, ни
 *    фонового пересчёта: значок — это не награда, которую надо хранить, а
 *    прочтение фактов о полке. Поэтому его нельзя «потерять» при сбое и
 *    незачем чинить рассинхрон.
 * 2. **Значки видит только их хозяин.** Публичный рейтинг библиотекарей
 *    превратил бы обмен книгами в соревнование, а тихому человеку с тремя
 *    книгами он ничего хорошего не скажет. Ручка требует подписи Telegram и
 *    отдаёт значки только про себя.
 * 3. **Незаработанные показываем с прогрессом.** «7 из 10 книг» объясняет, что
 *    делать дальше, и не выглядит упрёком. Пороги низкие намеренно: у половины
 *    библиотекарей полка меньше десяти книг, и обесценивать её нельзя
 *    (риск, записанный в issue).
 *
 * Функция `badgesFor` чистая: на входе числа, на выходе значки. Поэтому её
 * проверяет тест, а не глазами на проде (badges.test.ts).
 */
import { prisma } from './db.js'
import { workKeyOf } from './reviews.js'

/** Что мы знаем о человеке к моменту показа значков. */
export type LibrarianStats = {
  /** книг на полке: одобренные и живые */
  booksOnShelf: number
  /** сколько раз он давал свои книги другим */
  given: number
  /** из них вернулись */
  returned: number
  /** сколько книг он сам прочитал и вернул */
  read: number
  /** сколько оценок оставил */
  reviews: number
  /** скольким РАЗНЫМ людям давал книги */
  readers: number
  /** сколько книг вернулись ему в срок */
  onTime: number
  /** сколько раз книгу с его полки оценили на пять */
  topRated: number
}

export type Badge = {
  id: string
  title: string
  /** что человек сделал (для заработанного) или что нужно сделать */
  hint: string
  emoji: string
  earned: boolean
  /** прогресс до значка: current из target */
  current: number
  target: number
}

type BadgeDef = {
  id: string
  title: string
  hint: string
  /** запасной значок, если картинка не загрузилась */
  emoji: string
  target: number
  value: (s: LibrarianStats) => number
}

/**
 * Порядок важен: сначала про полку, потом про обмен, потом про чтение и
 * мнение — так значки читаются как история участия, а не как список задач.
 */
const DEFS: BadgeDef[] = [
  {
    id: 'first-book',
    title: 'Первая книга',
    hint: 'Поставить на полку первую книгу',
    emoji: '📗',
    target: 1,
    value: (s) => s.booksOnShelf,
  },
  {
    id: 'shelf-10',
    title: 'Полка на десять',
    hint: 'Собрать на полке десять книг',
    emoji: '📚',
    target: 10,
    value: (s) => s.booksOnShelf,
  },
  {
    id: 'shelf-25',
    title: 'Целая библиотека',
    hint: 'Собрать на полке двадцать пять книг',
    emoji: '🏛',
    target: 25,
    value: (s) => s.booksOnShelf,
  },
  {
    id: 'first-lend',
    title: 'Первая выдача',
    hint: 'Дать свою книгу кому-то почитать',
    emoji: '🤝',
    target: 1,
    value: (s) => s.given,
  },
  {
    id: 'lend-5',
    title: 'Книги ходят',
    hint: 'Дождаться возвращения пяти своих книг',
    emoji: '🔁',
    target: 5,
    value: (s) => s.returned,
  },
  {
    id: 'reader-3',
    title: 'Читатель',
    hint: 'Прочитать и вернуть три чужие книги',
    emoji: '🐝',
    target: 3,
    value: (s) => s.read,
  },
  {
    id: 'first-review',
    title: 'Первое мнение',
    hint: 'Оценить прочитанную книгу',
    emoji: '⭐',
    target: 1,
    value: (s) => s.reviews,
  },
  {
    id: 'friend-3',
    title: 'Книжный друг',
    hint: 'Дать книги трём разным людям',
    emoji: '🧸',
    target: 3,
    value: (s) => s.readers,
  },
  {
    id: 'keeper',
    title: 'Хранитель полки',
    hint: 'Дождаться трёх книг, вернувшихся в срок',
    emoji: '🏡',
    target: 3,
    value: (s) => s.onTime,
  },
  {
    id: 'rare-find',
    title: 'Редкая находка',
    hint: 'Книгу с вашей полки оценили на пять',
    emoji: '📕',
    target: 1,
    value: (s) => s.topRated,
  },
]

/**
 * Значки по статистике. Детерминированно: одни и те же числа дают один и тот
 * же ответ, порядок не плавает.
 */
export function badgesFor(s: LibrarianStats): Badge[] {
  return DEFS.map((d) => {
    const current = Math.max(0, d.value(s))
    return {
      id: d.id,
      title: d.title,
      hint: d.hint,
      emoji: d.emoji,
      earned: current >= d.target,
      // прогресс не перескакивает цель: «12 из 10» выглядит сломанным
      current: Math.min(current, d.target),
      target: d.target,
    }
  })
}

/** Собрать статистику человека одним заходом в базу. */
export async function statsFor(tgId: bigint): Promise<LibrarianStats> {
  const librarian = await prisma.librarian.findUnique({ where: { tgId }, select: { id: true } })
  const [booksOnShelf, given, returned, read, reviews, readerRows, onTime, myBooks] =
    await Promise.all([
      librarian
        ? prisma.book.count({
            where: { ownerId: librarian.id, active: true, reviewStatus: 'approved' },
          })
        : Promise.resolve(0),
      prisma.loan.count({ where: { ownerTg: tgId } }),
      prisma.loan.count({ where: { ownerTg: tgId, status: 'returned' } }),
      prisma.loan.count({ where: { holderTg: tgId, status: 'returned' } }),
      prisma.review.count({ where: { authorTg: tgId } }),
      // «книжный друг» считает ЛЮДЕЙ, а не выдачи: десять книг одному человеку
      // это не то же самое, что по книге десятерым
      prisma.loan.findMany({
        where: { ownerTg: tgId },
        select: { holderTg: true, holderUsername: true },
        take: 500,
      }),
      // «в срок» — только там, где срок вообще договаривались: выдача без dueAt
      // не может быть ни просроченной, ни возвращённой вовремя
      prisma.loan.count({
        where: { ownerTg: tgId, status: 'returned', dueAt: { not: null }, returnedAt: { not: null } },
      }),
      librarian
        ? prisma.book.findMany({
            where: { ownerId: librarian.id, active: true, reviewStatus: 'approved' },
            select: { title: true, author: true },
            take: 500,
          })
        : Promise.resolve([]),
    ])

  const readers = new Set(
    readerRows.map((l) => (l.holderTg ? `id:${l.holderTg}` : `nick:${l.holderUsername ?? ''}`)),
  )
  readers.delete('nick:')

  return {
    booksOnShelf,
    given,
    returned,
    read,
    reviews,
    readers: readers.size,
    onTime: await countOnTime(tgId, onTime),
    topRated: await countTopRated(tgId, myBooks),
  }
}

/**
 * Сколько книг вернулись в срок. Считаем сравнением дат, а не флагом: срок
 * могли сдвинуть, а запись о возврате честнее любого счётчика.
 */
async function countOnTime(tgId: bigint, candidates: number): Promise<number> {
  if (!candidates) return 0
  const rows = await prisma.loan.findMany({
    where: { ownerTg: tgId, status: 'returned', dueAt: { not: null }, returnedAt: { not: null } },
    select: { dueAt: true, returnedAt: true },
    take: 500,
  })
  return rows.filter((l) => l.returnedAt! <= l.dueAt!).length
}

/**
 * Сколько раз книгу с полки оценили на пять. Оценка живёт на произведении
 * (см. reviews.ts), поэтому и здесь ключ — произведение; свои пятёрки не
 * считаются, иначе значок выдавал бы себе сам владелец.
 */
async function countTopRated(
  tgId: bigint,
  books: { title: string; author: string | null }[],
): Promise<number> {
  if (!books.length) return 0
  const keys = [...new Set(books.map(workKeyOf))]
  return prisma.review.count({
    where: { workKey: { in: keys }, rating: 5, status: 'visible', authorTg: { not: tgId } },
  })
}

/** Значки человека: статистика плюс её прочтение. */
export async function badgesOf(tgId: bigint): Promise<{ badges: Badge[]; stats: LibrarianStats }> {
  const stats = await statsFor(tgId)
  return { badges: badgesFor(stats), stats }
}
