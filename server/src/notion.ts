/**
 * Чтение публичных баз Notion проекта «МнеНеЖалко».
 *
 * Страница проекта расшарена публично, поэтому используем неофициальный
 * read-only endpoint `api/v3/queryCollection` — интеграционный токен не нужен.
 * Ограничение сервера — 1000 строк на запрос, поэтому книги (3000+) забираем
 * рекурсивным делением по диапазонам даты добавления.
 */
import { env } from './env.js'
import { fetchWithTimeout } from './net.js'

const API = 'https://www.notion.so/api/v3'

/**
 * Потолок таймаута на один запрос к Notion: зависший fetch без AbortController
 * замораживал весь синк-цикл (следующий прогон планируется после текущего).
 */
export const NOTION_TIMEOUT_MS = Number(process.env.NOTION_TIMEOUT_MS || 30_000)

/**
 * Сколько строк просим за один запрос. Проверено живым запросом 2026-07-28:
 * queryCollection честно отдаёт limit=5000 (все 3240 книг, hasMore=false) —
 * «потолок 1000» был самоограничением клиента. hasMore при этом остаётся
 * страховкой: если сервер однажды начнёт резать, усечение не пройдёт молча
 * (шардирование по датам для книг, громкая ошибка для остальных).
 */
export const NOTION_FETCH_LIMIT = Number(process.env.NOTION_FETCH_LIMIT || 5000)

type Rec = Record<string, any>

async function post(path: string, body: Rec): Promise<Rec> {
  const res = await fetchWithTimeout(
    `${API}/${path}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; mnenezhalko-bot)',
      },
      body: JSON.stringify(body),
    },
    NOTION_TIMEOUT_MS,
  )
  if (!res.ok) {
    throw new Error(`Notion ${path} → ${res.status} ${await res.text().catch(() => '')}`)
  }
  return (await res.json()) as Rec
}

/** Записи приходят обёрнутыми в {role, value:{value:{...}}} — разворачиваем. */
function unwrap(v: any): Rec {
  let cur = v
  while (cur && typeof cur === 'object' && 'value' in cur) cur = cur.value
  return cur || {}
}

/** Текст из notion rich-text, без служебного маркера ‣ у relation/date. */
function text(prop: any): string {
  if (!Array.isArray(prop)) return ''
  return prop
    .map((x: any) => (Array.isArray(x) && x[0] !== '‣' ? x[0] : ''))
    .join('')
    .trim()
}

/** Ссылка из аннотации ['a', url] — так хранятся файлы и url-поля. */
function link(prop: any): string | null {
  if (!Array.isArray(prop)) return null
  for (const x of prop) {
    for (const fmt of (Array.isArray(x) && x[1]) || []) {
      if (Array.isArray(fmt) && fmt[0] === 'a') return fmt[1]
    }
  }
  return null
}

/** id связанных страниц из relation-поля. */
function relationIds(prop: any): string[] {
  const out: string[] = []
  if (!Array.isArray(prop)) return out
  for (const x of prop) {
    for (const fmt of (Array.isArray(x) && x[1]) || []) {
      if (Array.isArray(fmt) && fmt[0] === 'p' && fmt[1]) out.push(fmt[1])
    }
  }
  return out
}

function dateStart(prop: any): string | null {
  if (!Array.isArray(prop)) return null
  for (const x of prop) {
    for (const fmt of (Array.isArray(x) && x[1]) || []) {
      if (Array.isArray(fmt) && fmt[0] === 'd') return fmt[1]?.start_date ?? null
    }
  }
  return null
}

/** Загруженные в Notion файлы отдаются только через image-прокси. */
export function coverUrl(raw: string | null, blockId: string): string | null {
  if (!raw) return null
  if (raw.includes('secure.notion-static.com') || raw.includes('prod-files-secure')) {
    return `https://www.notion.so/image/${encodeURIComponent(raw)}?table=block&id=${blockId}&cache=v2`
  }
  return raw.startsWith('http') ? raw : null
}

export type Schema = { byName: Record<string, string>; typeById: Record<string, string> }

async function queryRaw(
  collection: string,
  view: string,
  filters: Rec[] | null,
  limit = NOTION_FETCH_LIMIT,
): Promise<Rec> {
  const loader: Rec = {
    type: 'reducer',
    reducers: { collection_group_results: { type: 'results', limit } },
    searchQuery: '',
    userTimeZone: 'Europe/Warsaw',
  }
  if (filters?.length) loader.filter = { operator: 'and', filters }
  return post('queryCollection', {
    source: { type: 'collection', id: collection, spaceId: env.notion.spaceId },
    collectionView: { id: view, spaceId: env.notion.spaceId },
    loader,
  })
}

function schemaOf(res: Rec): Schema {
  const coll = unwrap(Object.values(res.recordMap?.collection || {})[0])
  const byName: Record<string, string> = {}
  const typeById: Record<string, string> = {}
  for (const [pid, s] of Object.entries<any>(coll.schema || {})) {
    byName[s.name] = pid
    typeById[pid] = s.type
  }
  return { byName, typeById }
}

/** Схема коллекции: id свойств по имени и их типы. Нужна и для записи. */
export async function collectionSchema(collection: string, view: string): Promise<Schema> {
  return schemaOf(await queryRaw(collection, view, null, 1))
}

export type NotionRow = {
  id: string
  props: Record<string, any>
  raw: Rec
}

function rowsOf(res: Rec): NotionRow[] {
  const ids: string[] = res.result?.reducerResults?.collection_group_results?.blockIds || []
  const idSet = new Set(ids)
  const out: NotionRow[] = []
  for (const v of Object.values(res.recordMap?.block || {})) {
    const b = unwrap(v)
    if (b.type !== 'page' || !idSet.has(b.id)) continue
    out.push({ id: b.id, props: b.properties || {}, raw: b })
  }
  return out
}

function hasMore(res: Rec): boolean {
  return Boolean(res.result?.reducerResults?.collection_group_results?.hasMore)
}

const dateFilter = (pid: string, op: string, day: string) => ({
  property: pid,
  filter: {
    operator: op,
    value: { type: 'exact', value: { type: 'date', start_date: day } },
  },
})

/**
 * Забирает все строки коллекции. Если ответ упирается в лимит, у коллекций с
 * датой добавления рекурсивно делит диапазон по датам пополам, у остальных —
 * громко падает: молчаливое усечение (раньше — первые 1000 строк Owners и
 * Board Games) выглядело бы для синка как «эти строки пропали из Notion».
 */
async function fetchAll(
  collection: string,
  view: string,
  dateProp?: string,
): Promise<{ rows: NotionRow[]; schema: Schema }> {
  const first = await queryRaw(collection, view, null)
  const schema = schemaOf(first)
  if (!hasMore(first)) return { rows: rowsOf(first), schema }
  if (!dateProp) {
    throw new Error(
      `Notion: коллекция ${collection} вернула больше ${NOTION_FETCH_LIMIT} строк — ` +
        'поднимите NOTION_FETCH_LIMIT, иначе часть строк потеряется',
    )
  }

  const pid = schema.byName[dateProp]
  if (!pid) {
    throw new Error(
      `Notion: коллекция ${collection} упёрлась в лимит, а поле «${dateProp}» для шардирования не нашлось`,
    )
  }

  const byId = new Map<string, NotionRow>()
  const take = (rs: NotionRow[]) => rs.forEach((r) => byId.set(r.id, r))

  const shard = async (start: string, end: string, depth = 0): Promise<void> => {
    const res = await queryRaw(collection, view, [
      dateFilter(pid, 'date_is_on_or_after', start),
      dateFilter(pid, 'date_is_before', end),
    ])
    if (hasMore(res) && depth < 10) {
      const s = Date.parse(start)
      const e = Date.parse(end)
      const mid = new Date((s + e) / 2).toISOString().slice(0, 10)
      if (mid === start || mid === end) {
        take(rowsOf(res))
        return
      }
      await shard(start, mid, depth + 1)
      await shard(mid, end, depth + 1)
      return
    }
    take(rowsOf(res))
  }

  const nextYear = new Date().getUTCFullYear() + 1
  await shard('2015-01-01', `${nextYear}-01-01`)

  // строки без даты добавления попадают мимо диапазонов
  const empty = await queryRaw(collection, view, [
    { property: pid, filter: { operator: 'is_empty' } },
  ])
  take(rowsOf(empty))

  return { rows: [...byId.values()], schema }
}

export type NotionLibrarian = {
  notionId: string
  name: string
  telegram: string | null
  instagram: string | null
  city: string | null
  district: string | null
}

export type NotionBook = {
  notionId: string
  kind: 'book' | 'game'
  title: string
  author: string | null
  genres: string
  languages: string
  coverUrl: string | null
  status: string
  addedAt: Date | null
  ownerNotionId: string | null
  /** город указан прямо в карточке (у настолок), иначе берём у владельца */
  city?: string | null
  district?: string | null
}

const get = (row: NotionRow, schema: Schema, name: string) =>
  row.props[schema.byName[name] ?? '__missing__']

/** Города в Notion пишут по-разному; сводим к единому списку проекта. */
const CITY_ALIASES: Record<string, string> = {
  gdansk: 'Trójmiasto',
  gdańsk: 'Trójmiasto',
  gdynia: 'Trójmiasto',
  sopot: 'Trójmiasto',
  trojmiasto: 'Trójmiasto',
  trójmiasto: 'Trójmiasto',
  warszawa: 'Warszawa',
  warsaw: 'Warszawa',
  krakow: 'Kraków',
  kraków: 'Kraków',
  wroclaw: 'Wrocław',
  wrocław: 'Wrocław',
  poznan: 'Poznań',
  poznań: 'Poznań',
  lodz: 'Łódź',
  łódź: 'Łódź',
  bialystok: 'Białystok',
  białystok: 'Białystok',
  olsztyn: 'Olsztyn',
  radom: 'Radom',
}

/**
 * «Warszawa/Wola», «Gdańsk», «Wrocław,Wrocław» → { city, district }.
 * Значение multi-select может содержать несколько вариантов — берём первый.
 */
function splitCity(raw: string): { city: string | null; district: string | null } {
  const first = (raw || '').split(',')[0]?.trim()
  if (!first) return { city: null, district: null }
  const [cityRaw, districtRaw] = first.split('/').map((s) => s.trim())
  const city = CITY_ALIASES[(cityRaw || '').toLowerCase()] ?? cityRaw ?? null
  return { city: city || null, district: districtRaw || null }
}

/** Из «@handle» / «https://t.me/handle» делает канонический handle без «@». */
export function tgHandle(raw: string | null): string | null {
  if (!raw) return null
  const s = raw.trim()
  const m = s.match(/(?:t\.me\/|telegram\.me\/|@)([A-Za-z0-9_]{4,})/)
  if (m) return m[1]
  if (/^[A-Za-z0-9_]{4,}$/.test(s)) return s
  return null
}

/**
 * Ключ для матчинга библиотекаря по нику: канонический handle в нижнем регистре.
 * Ники Telegram регистронезависимы, поэтому сравниваем именно нормализованные.
 */
export const normHandle = (raw: string | null): string | null =>
  tgHandle(raw)?.toLowerCase() ?? null

export async function fetchLibrarians(): Promise<NotionLibrarian[]> {
  const { rows, schema } = await fetchAll(
    env.notion.librarians.collection,
    env.notion.librarians.view,
  )
  return rows.map((r) => {
    const { city, district } = splitCity(text(get(r, schema, 'City/District')))
    const tg =
      link(get(r, schema, '@Telegram')) || text(get(r, schema, '@Telegram')) || null
    return {
      notionId: r.id,
      name: text(get(r, schema, 'Name (and Surname)')) || 'Библиотекарь',
      telegram: tgHandle(tg),
      instagram: text(get(r, schema, 'Instagram')) || null,
      city,
      district,
    }
  })
}

export async function fetchBooks(): Promise<NotionBook[]> {
  const { rows, schema } = await fetchAll(
    env.notion.books.collection,
    env.notion.books.view,
    'Date added',
  )
  return rows
    .map((r): NotionBook | null => {
      const title = text(get(r, schema, 'Title'))
      if (!title) return null
      const added = dateStart(get(r, schema, 'Date added'))
      return {
        notionId: r.id,
        kind: 'book' as const,
        title,
        author: text(get(r, schema, 'Author')) || null,
        genres: text(get(r, schema, 'Genre')),
        languages: text(get(r, schema, 'Language')),
        coverUrl: coverUrl(link(get(r, schema, 'Cover')), r.id),
        status: 'free',
        addedAt: added ? new Date(added) : null,
        ownerNotionId: relationIds(get(r, schema, 'Owner (click on the name)'))[0] ?? null,
      }
    })
    .filter((b): b is NotionBook => b !== null)
}

export async function fetchGames(): Promise<NotionBook[]> {
  const { rows, schema } = await fetchAll(
    env.notion.games.collection,
    env.notion.games.view,
  )
  return rows
    .map((r): NotionBook | null => {
      const title = text(get(r, schema, 'Title'))
      if (!title) return null
      const status = text(get(r, schema, 'Status')).toLowerCase()
      const { city, district } = splitCity(text(get(r, schema, 'City/District')))
      return {
        notionId: r.id,
        kind: 'game' as const,
        title,
        author: null,
        genres: 'Настольная игра',
        languages: '',
        coverUrl: coverUrl(link(get(r, schema, 'Cover')), r.id),
        status: status === 'busy' ? 'busy' : 'free',
        addedAt: null,
        ownerNotionId: relationIds(get(r, schema, 'Owner'))[0] ?? null,
        city,
        district,
      }
    })
    .filter((b): b is NotionBook => b !== null)
}
