/**
 * Полнота чтения коллекций Notion (регрессия, пойманная смоуком на проде
 * 2026-07-28): на большой limit сервер отдаёт ВСЕ blockIds с hasMore=false,
 * но сами строки (recordMap.block) режет примерно до тысячи. Признак полноты —
 * строки пришли для всех id; неполный ответ шардируется по датам или громко
 * падает. Сеть не трогаем: query-функция инжектируется.
 * Запуск: npm run test -w server
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DISABLE_BOT = '1'

const { fetchAll, isCompleteResponse } = await import('./notion.js')

/** Ответ queryCollection: ids в результатах + payload только для payloadIds. */
function response(ids: string[], payloadIds: string[], hasMore = false) {
  return {
    result: { reducerResults: { collection_group_results: { blockIds: ids, hasMore } } },
    recordMap: {
      collection: {
        c1: {
          value: {
            value: { schema: { dd: { name: 'Date added', type: 'date' }, tt: { name: 'Title', type: 'title' } } },
          },
        },
      },
      block: Object.fromEntries(
        payloadIds.map((id) => [
          id,
          { value: { value: { id, type: 'page', properties: { tt: [[`Книга ${id}`]] } } } },
        ]),
      ),
    },
  }
}

const ids = (n: number, prefix = 'b') => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

test('isCompleteResponse: hasMore=false, но строк меньше, чем id — ответ НЕполный', () => {
  assert.equal(isCompleteResponse(response(ids(30), ids(30))), true)
  assert.equal(isCompleteResponse(response(ids(30), ids(10))), false, 'payload срезан')
  assert.equal(isCompleteResponse(response(ids(30), ids(30), true)), false, 'hasMore')
})

test('срезанный payload у коллекции с датой шардируется и собирает ВСЕ строки', async () => {
  const all = ids(40)
  const first = all.slice(0, 20)
  const second = all.slice(20)
  const query = async (_c: string, _v: string, filters: any[] | null) => {
    // запрос без фильтров «режется»: все id, но только 10 строк
    if (!filters?.length) return response(all, all.slice(0, 10))
    if (filters[0]?.filter?.operator === 'is_empty') return response([], [])
    const start = filters[0].filter.value.value.start_date as string
    const end = filters[1].filter.value.value.start_date as string
    // широкий диапазон всё ещё срезан — заставляет делить дальше
    if (start <= '2016-01-01' && end >= '2026-01-01') return response(all, all.slice(0, 10))
    // узкие половинки отдаём полными
    return start < '2020-01-01' ? response(first, first) : response(second, second)
  }
  const { rows } = await fetchAll('c1', 'v1', 'Date added', query as any)
  assert.equal(rows.length, 40, 'после шардирования должны прийти все строки')
})

test('срезанный payload у коллекции БЕЗ даты — громкая ошибка, не молчаливое усечение', async () => {
  const all = ids(1500, 'o')
  const query = async () => response(all, all.slice(0, 1000))
  await assert.rejects(() => fetchAll('c1', 'v1', undefined, query as any), /неполный ответ/)
})

test('полный ответ без даты проходит как есть', async () => {
  const all = ids(142, 'o')
  const query = async () => response(all, all)
  const { rows } = await fetchAll('c1', 'v1', undefined, query as any)
  assert.equal(rows.length, 142)
})
