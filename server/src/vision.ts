/**
 * Распознавание книги или настолки по фото обложки.
 *
 * Фото → Claude vision → поля карточки: название, автор, язык, жанры.
 * Жанры и языки берём строго из справочников Notion (наша база — их зеркало),
 * чтобы значения ложились в multi-select общей таблицы без мусора.
 */
import Anthropic from '@anthropic-ai/sdk'
import { env } from './env.js'
import { getTaxonomy, FALLBACK_LANGUAGES } from './taxonomy.js'

const client = env.anthropicKey ? new Anthropic({ apiKey: env.anthropicKey }) : null

export const visionEnabled = () => client !== null

/**
 * Языки и жанры модель берёт из справочника Notion (см. taxonomy.ts): раньше
 * список языков лежал здесь копией и расходился с таблицей, а жанры брались из
 * фактических значений каталога — вместе с мусором, накопленным свободным вводом
 * (в поле жанра встречалась даже ссылка на обложку).
 */
export const LANGUAGES = FALLBACK_LANGUAGES

const BOOK_FIELDS = {
  kind: { type: 'string', enum: ['book', 'game'] },
  title: { type: 'string', description: 'Название точно как на обложке, без серии и издательства' },
  author: { type: 'string', description: 'Автор или авторы через запятую; для настолок пустая строка' },
  languages: { type: 'array', items: { type: 'string' }, description: 'Язык издания, из списка' },
  genres: { type: 'array', items: { type: 'string' }, description: 'До 3 жанров строго из списка' },
  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
} as const

/** Несколько книг на одном фото: стопка, полка, разложенные обложки и корешки. */
const SCHEMA = {
  type: 'object',
  properties: {
    recognized: {
      type: 'boolean',
      description: 'true, если на фото есть хотя бы одна книга или настольная игра',
    },
    books: {
      type: 'array',
      description: 'Все различимые книги: и лицевые обложки, и корешки. Нечитаемые пропускать.',
      items: {
        type: 'object',
        properties: {
          ...BOOK_FIELDS,
          spine: {
            type: 'boolean',
            description: 'true, если книга видна только корешком (боком), а не лицевой обложкой',
          },
        },
        required: ['kind', 'title', 'author', 'languages', 'genres', 'confidence', 'spine'],
        additionalProperties: false,
      },
    },
    note: { type: 'string', description: 'Короткая подсказка человеку, если что-то нечитаемо' },
  },
  required: ['recognized', 'books', 'note'],
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
  /** книга видна только корешком — название прочитано сбоку, легче ошибиться */
  spine?: boolean
}

/** Результат разбора фото: сколько книг видно, и что не удалось прочитать. */
export type RecognizedPhoto = {
  books: Recognized[]
  note: string | null
}

/** Больше за раз не берём: длинный список человек всё равно не проверит глазами. */
export const MAX_BOOKS_PER_PHOTO = 12

const MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const
export type MediaType = (typeof MEDIA)[number]

export const isSupportedMedia = (t: string): t is MediaType => MEDIA.includes(t as MediaType)

/**
 * Разбор ответа модели в наши карточки. Вынесено отдельно, чтобы проверять
 * тестами без похода в сеть: именно здесь чистятся справочники и отсеивается
 * мусор («Название», пустые строки, дубли одной книги в кадре).
 */
export function parsePhotoAnswer(
  text: string,
  genreList: string[],
  languageList: string[] = FALLBACK_LANGUAGES,
): RecognizedPhoto | null {
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const known = new Set(genreList)
  const knownLanguages = new Set(languageList)
  const note = typeof raw?.note === 'string' && raw.note.trim() ? raw.note.trim() : null
  const list = Array.isArray(raw?.books) ? raw.books : []

  const seen = new Set<string>()
  const books: Recognized[] = []
  for (const b of list) {
    const title = typeof b?.title === 'string' ? b.title.trim() : ''
    if (title.length < 2) continue
    // одна и та же книга может попасть в ответ дважды (видна и обложкой, и корешком)
    const key = `${title.toLowerCase()}|${String(b?.author ?? '').trim().toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    books.push({
      recognized: true,
      kind: b?.kind === 'game' ? 'game' : 'book',
      title: title.slice(0, 300),
      author: typeof b?.author === 'string' && b.author.trim() ? b.author.trim().slice(0, 200) : null,
      languages: (Array.isArray(b?.languages) ? b.languages : [])
        .filter((l: unknown) => typeof l === 'string' && knownLanguages.has(l))
        .slice(0, 2),
      genres: (Array.isArray(b?.genres) ? b.genres : [])
        .filter((g: unknown) => typeof g === 'string' && known.has(g))
        .slice(0, 3),
      confidence: ['high', 'medium', 'low'].includes(b?.confidence) ? b.confidence : 'medium',
      note: null,
      spine: Boolean(b?.spine),
    })
    if (books.length >= MAX_BOOKS_PER_PHOTO) break
  }
  return { books, note }
}

/**
 * Распознаёт ВСЕ книги на фото: одну обложку, стопку или полку корешками.
 *
 * @param data изображение в base64 (без префикса data:)
 * @returns null, если ИИ недоступен или ответ не разобрался
 */
export async function recognizePhoto(
  data: string,
  mediaType: MediaType,
): Promise<RecognizedPhoto | null> {
  if (!client) return null

  const { genres: genreList, languages: languageList } = await getTaxonomy()

  const res = await client.messages.create({
    model: env.anthropicModel,
    max_tokens: 4000,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: SCHEMA },
    },
    system:
      'Ты помогаешь участникам книжного проекта «МнеНеЖалко» в Польше ставить книги на полку. ' +
      'На фото может быть одна обложка, коробка настольной игры, стопка книг или полка, ' +
      'где книги стоят корешками. Перечисли ВСЕ книги, которые различимы.\n' +
      'Правила:\n' +
      '— в books перечисляй КАЖДУЮ книгу отдельным элементом: и лицевые обложки, и корешки;\n' +
      '— книгу, у которой видно только корешок, помечай spine = true;\n' +
      '— название пиши на языке обложки, без подзаголовков серии, издательства и слоганов;\n' +
      '— автора пиши как на обложке; для настольной игры автор пустой, kind = game;\n' +
      '— НЕ ДОГАДЫВАЙСЯ: если название нечитаемо или видно только часть слова, пропусти книгу ' +
      'и напиши в note, сколько корешков не разобрал;\n' +
      '— одну и ту же книгу не перечисляй дважды;\n' +
      '— язык выбирай ТОЛЬКО из списка: ' + languageList.join(', ') + ';\n' +
      '— жанры выбирай ТОЛЬКО из списка ниже, дословно, не больше трёх; если ничего не подходит — пустой массив;\n' +
      '— если книг на фото нет вовсе, ставь recognized = false, books = [] и объясни в note, что переснять.\n\n' +
      'Доступные жанры:\n' + genreList.join(', '),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
          {
            type: 'text',
            text: 'Какие книги или игры на фото? Перечисли все, что читаются, для библиотеки.',
          },
        ],
      },
    ],
  })

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')

  return parsePhotoAnswer(text, genreList, languageList)
}

