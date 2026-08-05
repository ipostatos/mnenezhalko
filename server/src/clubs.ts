/**
 * Книжные клубы проекта (B7, ТЗ 5.08.2026).
 *
 * Раньше клуб был ровно один: `CLUB_URL` — адрес чата «Книжной Клумбы», зашитый
 * и в меню бота, и в плашку на главной. Но городов у проекта девять, а в одном
 * городе клубов может быть несколько, и встреча должна вести в СВОЙ клуб, а не
 * в единственный общий. Поэтому контракт стал множественным.
 *
 * ГДЕ ЖИВУТ ДАННЫЕ. Готового источника нет: в Notion проекта клубов нет вовсе
 * (там книги, владельцы и настолки), в базе — тоже. Заводить таблицу под список
 * из нескольких строк, который меняется раз в полгода, ещё рано: это отдельная
 * миграция и админский экран ради данных, которые проще держать настройкой.
 * Поэтому источник — одна переменная `CLUBS_JSON` со списком, а не набор
 * `CLUB_URL_1`, `CLUB_URL_2` (такой набор невозможно ни отсортировать, ни
 * расширить описанием). Когда клубов станет много и их захотят править не
 * руками — переезд в базу будет уже с готовым контрактом.
 *
 * Старый `CLUB_URL` продолжает работать (deprecated): если `CLUBS_JSON` не
 * задан, из него собирается один клуб — прод не должен остаться без клуба
 * из-за того, что настройку не успели поменять.
 */

export type BookClub = {
  id: string
  name: string
  city: string
  description?: string
  url: string
  active: boolean
  sortOrder?: number
}

/** Клуб по умолчанию: тот самый единственный, что был до множественного списка. */
const LEGACY_CLUB_NAME = 'Книжная Клумба МнеНеЖалко'

function parseClubs(raw: string): BookClub[] {
  const list = JSON.parse(raw)
  if (!Array.isArray(list)) throw new Error('CLUBS_JSON: ожидался список')
  return list.map((c: Record<string, unknown>, i: number) => {
    const id = String(c.id ?? '').trim()
    const name = String(c.name ?? '').trim()
    const url = String(c.url ?? '').trim()
    const city = String(c.city ?? '').trim()
    if (!id || !name || !url || !city) {
      throw new Error(`CLUBS_JSON[${i}]: нужны id, name, city и url`)
    }
    if (!/^https?:\/\//i.test(url)) throw new Error(`CLUBS_JSON[${i}]: url должен быть http(s)`)
    return {
      id,
      name,
      city,
      url,
      description: c.description ? String(c.description) : undefined,
      // active по умолчанию true: список правят руками, и «забыл написать true»
      // не должно молча прятать клуб
      active: c.active === undefined ? true : Boolean(c.active),
      sortOrder: c.sortOrder === undefined ? undefined : Number(c.sortOrder),
    }
  })
}

let cached: BookClub[] | null = null

/**
 * Все клубы (включая выключенные) в порядке показа. Разбор делается один раз:
 * ошибка в настройке не должна валить сервер — тогда людям станет недоступен
 * весь бот из-за опечатки в списке клубов. Поэтому при поломке остаёмся на
 * старом `CLUB_URL` и громко пишем в лог.
 */
export function allClubs(): BookClub[] {
  if (cached) return cached
  const raw = (process.env.CLUBS_JSON || '').trim()
  if (raw) {
    try {
      cached = sortClubs(parseClubs(raw))
      return cached
    } catch (e: unknown) {
      console.error(`[clubs] CLUBS_JSON не разобран (${(e as Error).message}) — беру CLUB_URL`)
    }
  }
  const legacy = (process.env.CLUB_URL || 'https://t.me/bookclub_mnzh').trim()
  cached = [
    {
      id: 'klumba',
      name: LEGACY_CLUB_NAME,
      // общий клуб проекта: он не привязан к одному городу
      city: '',
      url: legacy,
      active: true,
    },
  ]
  return cached
}

/**
 * Порядок: сначала город (список и на экране, и в боте сгруппирован по городам),
 * внутри города — sortOrder, потом имя. Глобальный sortOrder был бы бесполезен:
 * он растащил бы клубы одного города по разным местам списка.
 */
function sortClubs(list: BookClub[]): BookClub[] {
  return [...list].sort(
    (a, b) =>
      a.city.localeCompare(b.city, 'ru') ||
      (a.sortOrder ?? 1000) - (b.sortOrder ?? 1000) ||
      a.name.localeCompare(b.name, 'ru'),
  )
}

/** Клубы, которые показываем людям. */
export const activeClubs = (): BookClub[] => allClubs().filter((c) => c.active)

/** Клуб по id — для встречи, которая ведёт в конкретный клуб, а не «в город». */
export const clubById = (id: string | null | undefined): BookClub | null =>
  (id && activeClubs().find((c) => c.id === id)) || null

/**
 * Адрес «главного» клуба — только для обратной совместимости (меню бота, старая
 * плашка). Осознанно берёт ПЕРВЫЙ активный, а не «клуб города»: определять клуб
 * по городу нельзя, их там может быть несколько.
 */
export const primaryClubUrl = (): string => activeClubs()[0]?.url ?? ''

/** Сброс разобранного списка — тестам и на случай смены настройки без рестарта. */
export function resetClubsCache(): void {
  cached = null
}
