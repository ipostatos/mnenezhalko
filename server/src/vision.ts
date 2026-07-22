/**
 * Распознавание книги или настолки по фото обложки.
 *
 * Фото → Claude vision → поля карточки: название, автор, язык, жанры.
 * Жанры и языки берём строго из справочников Notion (наша база — их зеркало),
 * чтобы значения ложились в multi-select общей таблицы без мусора.
 */
import Anthropic from '@anthropic-ai/sdk'
import { env } from './env.js'
import { facets } from './search.js'

const client = env.anthropicKey ? new Anthropic({ apiKey: env.anthropicKey }) : null

export const visionEnabled = () => client !== null

/** Языки — весь справочник Language из таблицы All Books. */
export const LANGUAGES = [
  'Русский',
  'Polski',
  'English',
  'Українська',
  'Беларуская',
  'Deutsch',
  'Español',
  'Français',
  'Italiana',
  'Łacinka',
  'Трасянка',
]

const SCHEMA = {
  type: 'object',
  properties: {
    recognized: {
      type: 'boolean',
      description: 'true, если на фото действительно книга или настольная игра',
    },
    kind: { type: 'string', enum: ['book', 'game'] },
    title: { type: 'string', description: 'Название точно как на обложке, без серии и издательства' },
    author: { type: 'string', description: 'Автор или авторы через запятую; для настолок пустая строка' },
    languages: { type: 'array', items: { type: 'string' }, description: 'Язык издания, из списка' },
    genres: { type: 'array', items: { type: 'string' }, description: 'До 3 жанров строго из списка' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    note: { type: 'string', description: 'Короткая подсказка человеку, если что-то нечитаемо' },
  },
  required: ['recognized', 'kind', 'title', 'author', 'languages', 'genres', 'confidence', 'note'],
  additionalProperties: false,
} as const

export type Recognized = {
  recognized: boolean
  kind: 'book' | 'game'
  title: string
  author: string | null
  languages: string[]
  genres: string[]
  confidence: 'high' | 'medium' | 'low'
  note: string | null
}

const MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const
export type MediaType = (typeof MEDIA)[number]

export const isSupportedMedia = (t: string): t is MediaType => MEDIA.includes(t as MediaType)

/**
 * @param data изображение в base64 (без префикса data:)
 * @returns null, если ИИ недоступен или ответ не разобрался
 */
export async function recognizeCover(data: string, mediaType: MediaType): Promise<Recognized | null> {
  if (!client) return null

  const f = await facets()
  const genreList = f.genres.map((g) => g.value)

  const res = await client.messages.create({
    model: env.anthropicModel,
    max_tokens: 800,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: SCHEMA },
    },
    system:
      'Ты помогаешь участникам книжного проекта «МнеНеЖалко» в Польше ставить книги на полку. ' +
      'На фото — обложка книги или коробка настольной игры. Определи, что это, и заполни карточку.\n' +
      'Правила:\n' +
      '— название пиши на языке обложки, без подзаголовков серии, издательства и слоганов;\n' +
      '— автора пиши как на обложке; для настольной игры автор пустой, kind = game;\n' +
      '— язык выбирай ТОЛЬКО из списка: ' + LANGUAGES.join(', ') + ';\n' +
      '— жанры выбирай ТОЛЬКО из списка ниже, дословно, не больше трёх; если ничего не подходит — пустой массив;\n' +
      '— если книгу видно плохо или это не книга, ставь recognized = false и объясни в note, что переснять.\n\n' +
      'Доступные жанры:\n' + genreList.join(', '),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
          { type: 'text', text: 'Что это за книга или игра? Заполни карточку для библиотеки.' },
        ],
      },
    ],
  })

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')

  try {
    const raw = JSON.parse(text) as Recognized
    // подстраховка: справочники могли «поплыть» — оставляем только известные значения
    const known = new Set(genreList)
    return {
      ...raw,
      author: raw.author?.trim() ? raw.author.trim() : null,
      note: raw.note?.trim() ? raw.note.trim() : null,
      genres: (raw.genres || []).filter((g) => known.has(g)).slice(0, 3),
      languages: (raw.languages || []).filter((l) => LANGUAGES.includes(l)).slice(0, 2),
    }
  } catch {
    return null
  }
}
