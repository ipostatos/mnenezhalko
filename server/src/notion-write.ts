/**
 * Запись в общие таблицы Notion проекта — то, что человек делает руками
 * по инструкции новичка: заводит себя в Owners и добавляет строку в All Books
 * (или в Board Games для настолок).
 *
 * Таблицы расшарены публичной ссылкой с правом `read_and_write`, но анонимно
 * Notion писать не даёт (`saveTransactions` → 401 Must be authenticated),
 * поэтому работаем от служебного аккаунта: cookie `token_v2` в NOTION_TOKEN_V2.
 * Без токена модуль выключен, карточки копятся локально со статусом `pending`.
 *
 * API неофициальный: имена эндпоинтов Notion меняет (submitTransaction уже
 * исчез), поэтому пишем через первый живой из списка и говорим об ошибке вслух.
 */
import { randomUUID } from 'node:crypto'
import { env } from './env.js'
import { collectionSchema, type Schema } from './notion.js'

const API = 'https://www.notion.so/api/v3'
const SAVE_ENDPOINTS = ['saveTransactionsFanout', 'saveTransactions']

export const notionWriteEnabled = () => Boolean(env.notionToken)

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; mnenezhalko-bot)',
    cookie: `token_v2=${env.notionToken}`,
  }
  // нужен, когда у аккаунта несколько пространств
  if (env.notionUserId) h['x-notion-active-user-header'] = env.notionUserId
  return h
}

async function call(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Notion ${path} → ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

/** Записи приходят как {role, value:{value:{…}}} — разворачиваем до данных. */
function unwrap(v: any): any {
  let cur = v
  while (cur && typeof cur === 'object' && 'value' in cur) cur = cur.value
  return cur
}

/** Проверка токена: кто мы для Notion. */
export async function whoAmI(): Promise<{ id: string; email: string | null } | null> {
  if (!notionWriteEnabled()) return null
  const res = await call('loadUserContent', {})
  const u = unwrap(Object.values<any>(res.recordMap?.notion_user || {})[0])
  return u?.id ? { id: u.id, email: u.email ?? null } : null
}

type Op = { pointer: { table: string; id: string; spaceId: string }; path: string[]; command: string; args: any }

const op = (id: string, path: string[], command: string, args: any): Op => ({
  pointer: { table: 'block', id, spaceId: env.notion.spaceId },
  path,
  command,
  args,
})

async function submit(operations: Op[]): Promise<void> {
  const body = {
    requestId: randomUUID(),
    transactions: [
      {
        id: randomUUID(),
        spaceId: env.notion.spaceId,
        debug: { userAction: 'mnenezhalko-bot' },
        operations,
      },
    ],
  }
  let lastError: unknown = null
  for (const endpoint of SAVE_ENDPOINTS) {
    try {
      await call(endpoint, body)
      return
    } catch (e: any) {
      // 404 — эндпоинта больше нет, пробуем следующий; остальное — настоящая ошибка
      if (!String(e?.message).includes('→ 404')) throw e
      lastError = e
    }
  }
  throw lastError ?? new Error('Notion: не нашёлся эндпоинт записи')
}

/* ── значения свойств в формате Notion ────────────────────── */

const vText = (s: string) => [[s]]
const vMulti = (values: string[]) => [[values.filter(Boolean).join(',')]]
const vUrl = (url: string) => [[url, [['a', url]]]]
/** Внешняя картинка в file-поле — то же «Embed link» из инструкции. */
const vFile = (url: string) => [[url, [['a', url]]]]
const vRelation = (pageIds: string[]) =>
  pageIds.flatMap((id, i) => (i ? [[','], ['‣', [['p', id, env.notion.spaceId]]]] : [['‣', [['p', id, env.notion.spaceId]]]]))
const vDate = (iso: string) => [['‣', [['d', { type: 'date', start_date: iso.slice(0, 10) }]]]]
const vStatus = (s: string) => [[s]]

/* ── схемы таблиц (кешируем: имена свойств меняются редко) ── */

let cache: { books?: Schema; owners?: Schema; games?: Schema } = {}

async function schemas() {
  if (!cache.books) {
    const [books, owners, games] = await Promise.all([
      collectionSchema(env.notion.books.collection, env.notion.books.view),
      collectionSchema(env.notion.librarians.collection, env.notion.librarians.view),
      collectionSchema(env.notion.games.collection, env.notion.games.view),
    ])
    cache = { books, owners, games }
  }
  return cache as Required<typeof cache>
}

/** Сбросить кеш схем (после правок структуры таблиц в Notion). */
export const resetSchemaCache = () => {
  cache = {}
}

type Props = Array<[pid: string | undefined, value: unknown]>

function createRowOps(collectionId: string, props: Props): { id: string; ops: Op[] } {
  const id = randomUUID()
  const now = Date.now()
  const ops: Op[] = [
    op(id, [], 'set', { type: 'page', id, version: 1 }),
    op(id, [], 'update', {
      parent_id: collectionId,
      parent_table: 'collection',
      space_id: env.notion.spaceId,
      alive: true,
      created_time: now,
      last_edited_time: now,
    }),
  ]
  for (const [pid, value] of props) {
    if (!pid || value === undefined || value === null) continue
    ops.push(op(id, ['properties', pid], 'set', value))
  }
  return { id, ops }
}

/* ── публичные операции ───────────────────────────────────── */

export type OwnerDraft = {
  name: string
  telegram?: string | null
  instagram?: string | null
  /** «Warszawa/Wola» — в Owners город и район живут одним значением */
  cityDistrict?: string | null
}

/** Заводит библиотекаря в таблице Owners, возвращает id страницы. */
export async function createOwner(o: OwnerDraft): Promise<string> {
  const { owners } = await schemas()
  const { id, ops } = createRowOps(env.notion.librarians.collection, [
    ['title', vText(o.name)],
    [owners.byName['City/District'], o.cityDistrict ? vMulti([o.cityDistrict]) : null],
    [owners.byName['@Telegram'], o.telegram ? vUrl(`https://t.me/${o.telegram.replace(/^@/, '')}`) : null],
    [owners.byName['Instagram'], o.instagram ? vUrl(o.instagram) : null],
  ])
  await submit(ops)
  return id
}

export type BookDraft = {
  kind: 'book' | 'game'
  title: string
  author?: string | null
  genres?: string[]
  languages?: string[]
  coverUrl?: string | null
  ownerNotionId?: string | null
  /** только для настолок: «Warszawa/Wola» */
  cityDistrict?: string | null
}

/**
 * Добавляет строку в All Books либо в Board Games — по типу карточки.
 * Возвращает id созданной страницы Notion.
 */
export async function createBook(b: BookDraft): Promise<string> {
  const s = await schemas()
  const owners = b.ownerNotionId ? [b.ownerNotionId] : []

  const { id, ops } =
    b.kind === 'game'
      ? createRowOps(env.notion.games.collection, [
          ['title', vText(b.title)],
          [s.games.byName['Owner'], owners.length ? vRelation(owners) : null],
          [s.games.byName['Cover'], b.coverUrl ? vFile(b.coverUrl) : null],
          [s.games.byName['City/District'], b.cityDistrict ? vMulti([b.cityDistrict]) : null],
          [s.games.byName['Status'], vStatus('Free')],
        ])
      : createRowOps(env.notion.books.collection, [
          ['title', vText(b.title)],
          [s.books.byName['Author'], b.author ? vMulti([b.author]) : null],
          [s.books.byName['Genre'], b.genres?.length ? vMulti(b.genres) : null],
          [s.books.byName['Language'], b.languages?.length ? vMulti(b.languages) : null],
          [s.books.byName['Cover'], b.coverUrl ? vFile(b.coverUrl) : null],
          [s.books.byName['Owner (click on the name)'], owners.length ? vRelation(owners) : null],
          [s.books.byName['Date added'], vDate(new Date().toISOString())],
        ])

  await submit(ops)

  // связь Owner ↔ книга двусторонняя: дописываем обратную сторону у владельца
  if (b.ownerNotionId) {
    await linkOwnerSide(b.ownerNotionId, id, b.kind).catch((e) =>
      console.warn('[notion] обратная связь у владельца не проставилась:', e?.message ?? e),
    )
  }
  return id
}

/** Читает блок (строку таблицы) по id. */
export async function loadBlock(id: string): Promise<any> {
  const res = await call('syncRecordValues', {
    requests: [{ pointer: { table: 'block', id, spaceId: env.notion.spaceId }, version: -1 }],
  })
  return unwrap(res.recordMap?.block?.[id]) ?? null
}

/** Добавляет книгу в relation-поле владельца, сохраняя уже связанные. */
async function linkOwnerSide(ownerId: string, bookId: string, kind: 'book' | 'game'): Promise<void> {
  const { owners } = await schemas()
  const pid = owners.byName[kind === 'game' ? '🎲 Board Games' : '🎃 All Books']
  if (!pid) return

  const block = await loadBlock(ownerId)
  const current: string[] = []
  for (const x of block?.properties?.[pid] ?? []) {
    for (const fmt of (Array.isArray(x) && x[1]) || []) {
      if (Array.isArray(fmt) && fmt[0] === 'p' && fmt[1]) current.push(fmt[1])
    }
  }
  if (current.includes(bookId)) return
  await submit([op(ownerId, ['properties', pid], 'set', vRelation([...current, bookId]))])
}

/** Мягкое удаление строки — нужно для тестового прогона. */
export async function archiveRow(id: string): Promise<void> {
  await submit([op(id, [], 'update', { alive: false, last_edited_time: Date.now() })])
}
