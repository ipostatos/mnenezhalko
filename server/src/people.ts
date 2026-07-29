/**
 * Подсказка людей при вводе ника: «кому отдали книгу».
 *
 * Ники в Telegram бывают длинные и с любым регистром, и вводить их вручную с
 * телефона мучительно — при этом почти всегда речь о человеке, который уже
 * есть в проекте.
 *
 * Откуда берём людей и, главное, откуда НЕ берём:
 *
 * 1. **Библиотекари** — их имена и ники лежат в открытой таблице проекта,
 *    подсказка ничего нового не раскрывает.
 * 2. **Те, кому спрашивающий уже давал книги** — его собственная история.
 *
 * И ни в коем случае не все, кто открывал бота: человек мог просто зайти
 * посмотреть каталог, и превращать это в справочник ников было бы утечкой
 * (правила контактов — privacy.ts). По той же причине наружу уходит только имя
 * и ник, без числового tgId и без города.
 */
import { norm, prisma } from './db.js'
import { normHandle } from './notion.js'

export type Person = {
  /** как показать человека в списке */
  name: string
  /** ник без @ — его и подставляем в поле */
  telegram: string
  /** откуда он: свои прошлые читатели идут первыми */
  source: 'history' | 'librarian'
}

/** Больше восьми подсказок в список на телефоне всё равно не влезает. */
export const PEOPLE_LIMIT = 8

/**
 * Совпадение по началу ника или имени: человек печатает первые буквы, а не
 * середину. Подстрока разрешена вторым эшелоном — ники часто начинаются с
 * имени, а ищут по фамилии.
 */
export function rankPerson(p: Person, needle: string): number {
  const q = norm(needle)
  const tg = norm(p.telegram)
  const name = norm(p.name)
  if (tg.startsWith(q)) return 0
  if (name.startsWith(q)) return 1
  if (tg.includes(q)) return 2
  if (name.includes(q)) return 3
  return 99
}

/** Дедуп по нику: один человек может быть и библиотекарем, и знакомым. */
export function mergePeople(lists: Person[][], needle: string): Person[] {
  const byHandle = new Map<string, Person>()
  for (const list of lists) {
    for (const p of list) {
      const key = p.telegram.toLowerCase()
      if (!key) continue
      const seen = byHandle.get(key)
      // история важнее справочника: там человек уже знаком спрашивающему
      if (!seen || (seen.source === 'librarian' && p.source === 'history')) byHandle.set(key, p)
    }
  }
  return [...byHandle.values()]
    .map((p) => ({ p, rank: rankPerson(p, needle) }))
    .filter((x) => x.rank < 99)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        // при равном совпадении первым идёт тот, кому уже давали книги
        Number(a.p.source === 'librarian') - Number(b.p.source === 'librarian') ||
        a.p.telegram.localeCompare(b.p.telegram),
    )
    .slice(0, PEOPLE_LIMIT)
    .map((x) => x.p)
}

/**
 * Кого предложить на введённый кусок ника. Пустой запрос — пустой ответ:
 * список «всех людей проекта» это не подсказка, а выгрузка.
 */
export async function suggestPeople(viewerTg: bigint, query: string): Promise<Person[]> {
  const needle = normHandle(query) || query.trim().toLowerCase()
  if (needle.length < 1) return []

  /**
   * Отбор идёт в памяти, а не запросом с `contains`.
   *
   * SQLite сравнивает LIKE без учёта регистра только для латиницы: «Лиза» не
   * нашла бы библиотекаря «Лиза Ж», а половина имён в проекте кириллические.
   * Библиотекарей около полутора сотен, своих выдач — десятки, так что читать
   * их целиком дешевле, чем заводить ещё одну нормализованную колонку.
   */
  const [librarians, mine] = await Promise.all([
    prisma.librarian.findMany({
      // архивные дубли не предлагаем: книги у них уже не числятся
      where: { mergedIntoId: null, telegram: { not: null } },
      select: { name: true, telegram: true, telegramNorm: true, tgId: true },
      take: 500,
    }),
    prisma.loan.findMany({
      where: { ownerTg: viewerTg, holderUsername: { not: null } },
      select: { holderUsername: true, holderName: true },
      orderBy: { takenAt: 'desc' },
      take: 200,
    }),
  ])

  const fromLibrarians: Person[] = librarians
    .filter((l) => l.tgId !== viewerTg) // себе книгу не отдают
    .map((l) => ({
      name: l.name,
      telegram: (l.telegramNorm || normHandle(l.telegram ?? '') || '').replace(/^@/, ''),
      source: 'librarian' as const,
    }))
    .filter((p) => p.telegram)

  const fromHistory: Person[] = mine
    .filter((l) => l.holderUsername)
    .map((l) => ({
      name: l.holderName?.trim() || `@${l.holderUsername}`,
      telegram: l.holderUsername!,
      source: 'history' as const,
    }))

  return mergePeople([fromHistory, fromLibrarians], needle)
}
