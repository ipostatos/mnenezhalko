/**
 * ИИ-помощник: «хочу почитать про любовь и приключения» → подборка книг
 * из библиотеки проекта с контактами владельцев.
 *
 * Две ступени:
 *   1) свободный текст → структурированный запрос (жанры, ключевые слова, язык);
 *   2) кандидаты из базы → топ-5 с короткими объяснениями.
 * Без ключа ANTHROPIC_API_KEY обе ступени деградируют до обычного поиска.
 */
import Anthropic from '@anthropic-ai/sdk'
import { env } from './env.js'
import { facets, searchBooks, type BookCard } from './search.js'

const client = env.anthropicKey ? new Anthropic({ apiKey: env.anthropicKey }) : null

export const aiEnabled = () => client !== null

const QUERY_SCHEMA = {
  type: 'object',
  properties: {
    genres: {
      type: 'array',
      items: { type: 'string' },
      description: 'Жанры строго из предложенного списка, максимум 4',
    },
    keywords: {
      type: 'array',
      items: { type: 'string' },
      description: 'Ключевые слова для поиска по названию и автору, максимум 4',
    },
    languages: { type: 'array', items: { type: 'string' } },
    intro: { type: 'string', description: 'Одна дружелюбная фраза-подводка на языке запроса' },
  },
  required: ['genres', 'keywords', 'languages', 'intro'],
  additionalProperties: false,
} as const

const PICK_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          why: { type: 'string', description: 'Почему подходит, одно предложение' },
        },
        required: ['id', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['picks'],
  additionalProperties: false,
} as const

type ParsedQuery = {
  genres: string[]
  keywords: string[]
  languages: string[]
  intro: string
}

function textOf(res: Anthropic.Message): string {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

async function parseQuery(text: string, genreList: string[]): Promise<ParsedQuery | null> {
  if (!client) return null
  const res = await client.messages.create({
    model: env.anthropicModel,
    max_tokens: 1000,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: QUERY_SCHEMA },
    },
    system:
      'Ты помощник книжного клуба «МнеНеЖалко» в Польше. Пользователь описывает настроение ' +
      'или тему, а ты превращаешь это в поисковый запрос по библиотеке. ' +
      'Жанры выбирай ТОЛЬКО из списка ниже, дословно. Если ничего не подходит — пустой массив. ' +
      'Ключевые слова — короткие, на языке книг (чаще русский). ' +
      'Языки указывай только если человек прямо просил.\n\nДоступные жанры:\n' +
      genreList.join(', '),
    messages: [{ role: 'user', content: text }],
  })
  try {
    return JSON.parse(textOf(res)) as ParsedQuery
  } catch {
    return null
  }
}

async function pickBest(text: string, candidates: BookCard[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!client || candidates.length === 0) return out
  const list = candidates
    .slice(0, 40)
    .map((b) => `${b.id} | ${b.title} | ${b.author ?? '—'} | ${b.genres.join(', ')} | ${b.city ?? '—'}`)
    .join('\n')
  const res = await client.messages.create({
    model: env.anthropicModel,
    max_tokens: 1500,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: PICK_SCHEMA },
    },
    system:
      'Выбери из списка до 5 книг, которые лучше всего отвечают запросу человека. ' +
      'Используй только id из списка. Объяснение — одно живое предложение на языке запроса, ' +
      'без пересказа сюжета целиком.',
    messages: [
      {
        role: 'user',
        content: `Запрос: ${text}\n\nКниги (id | название | автор | жанры | город):\n${list}`,
      },
    ],
  })
  try {
    const parsed = JSON.parse(textOf(res)) as { picks: { id: string; why: string }[] }
    for (const p of parsed.picks) out.set(p.id, p.why)
  } catch {
    /* молча падаем на обычный порядок */
  }
  return out
}

export type AiResult = {
  intro: string
  items: (BookCard & { why?: string })[]
  usedAi: boolean
}

/**
 * @param text свободный запрос пользователя
 * @param city ограничить город (необязательно)
 */
export async function askAi(text: string, city?: string): Promise<AiResult> {
  /** Без ключа (или при сбое) ищем словами: сперва фразой, затем по токенам. */
  const fallback = async (): Promise<AiResult> => {
    const found = new Map<string, BookCard>()
    const { items } = await searchBooks({ q: text, city, limit: 10 })
    items.forEach((b) => found.set(b.id, b))

    if (found.size === 0) {
      const tokens = text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 4)
        .slice(0, 5)
      for (const token of tokens) {
        const r = await searchBooks({ q: token, city, limit: 6 })
        r.items.forEach((b) => found.set(b.id, b))
      }
    }

    const list = [...found.values()].slice(0, 10)
    return {
      intro: list.length
        ? 'Вот что нашлось в библиотеке:'
        : 'Ничего не нашлось — попробуйте другими словами.',
      items: list,
      usedAi: false,
    }
  }

  if (!client) return fallback()

  const f = await facets(city)
  const q = await parseQuery(text, f.genres.map((g) => g.value))
  if (!q) return fallback()

  // собираем кандидатов: по каждому жанру и ключевому слову отдельно, затем склеиваем
  const buckets: BookCard[][] = []
  for (const genre of q.genres.slice(0, 4)) {
    const { items } = await searchBooks({ genre, city, limit: 15 })
    buckets.push(items)
  }
  for (const kw of q.keywords.slice(0, 4)) {
    const { items } = await searchBooks({ q: kw, city, limit: 10 })
    buckets.push(items)
  }
  if (buckets.length === 0) {
    const { items } = await searchBooks({ q: text, city, limit: 20 })
    buckets.push(items)
  }

  const byId = new Map<string, BookCard>()
  for (const bucket of buckets) for (const b of bucket) byId.set(b.id, b)
  let candidates = [...byId.values()]

  if (q.languages.length) {
    const filtered = candidates.filter((b) =>
      b.languages.some((l) => q.languages.includes(l)),
    )
    if (filtered.length) candidates = filtered
  }

  if (candidates.length === 0) return fallback()

  const why = await pickBest(text, candidates)
  const picked = candidates
    .filter((b) => why.has(b.id))
    .map((b) => ({ ...b, why: why.get(b.id) }))

  const items = picked.length ? picked : candidates.slice(0, 5)
  return { intro: q.intro || 'Вот что подобралось:', items, usedAi: true }
}
