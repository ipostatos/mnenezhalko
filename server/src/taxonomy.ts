/**
 * Справочник жанров и языков проекта.
 *
 * Единственный источник правды — общая таблица Notion: и «Genre», и «Language»
 * там multi_select, то есть у них есть готовый список вариантов. Приложение из
 * этого списка только ВЫБИРАЕТ: свободный ввод разводил синонимы («Нонфикшн» /
 * «Нонфик»), опечатки («фальклор») и мусор (в поле жанра лежала ссылка на
 * обложку), а каждое новое значение, уехав в Notion, навсегда добавляло вариант
 * в справочник — админам потом разбирать вручную.
 *
 * Список читается из схемы коллекции при синке и переживает рестарт в SyncState;
 * снимок FALLBACK_* нужен на первый запуск и на случай, когда Notion недоступен.
 * Новый жанр появляется в приложении сам, как только его заведут в Notion.
 */
import { prisma } from './db.js'
import { env } from './env.js'
import { collectionSchema, type Schema } from './notion.js'

/** Ключ в SyncState, где лежит последний прочитанный из Notion справочник. */
export const TAXONOMY_KEY = 'taxonomy:books'

/** Имена свойств в таблице книг. */
const GENRE_PROP = 'Genre'
const LANGUAGE_PROP = 'Language'

/** Сколько значений разрешаем на книгу: защита от «выбрал всё подряд». */
export const MAX_GENRES = 8
export const MAX_LANGUAGES = 5

/** Снимок вариантов Notion на 2026-07-29 (135 жанров / 11 языков). */
export const FALLBACK_GENRES = [
  'Антиутопия', 'Биография/Мемуары', 'Детская литература', 'Искусство', 'Исторический роман',
  'История', 'Здоровье', 'Классика', 'Комикс/манга/графический роман', 'Маркетинг/Реклама',
  'Любовный роман', 'Научпоп', 'Отношения', 'Политика', 'Приключения', 'Психология',
  'Путеводитель', 'Путешествие', 'Рассказы', 'Самоучитель', 'Селфхелп', 'Сказка', 'Фантастика',
  'Современная проза', 'Фентези', 'Фотография', 'Профессиональные', 'Поэзия', 'Триллер',
  'Детектив', 'Дизайн', 'IT', 'Креатив', 'Саморазвитие', 'Бизнес', 'Менеджмент', 'Питание',
  'ЗОЖ', 'Нонфикшн', 'Родительство', 'Воспитание детей', 'Медицина', 'Тело человека',
  'Эзотерика', 'Публицистика', 'Домоводство', 'Young Adult', 'Личная эфективность',
  'Драматургия', 'Экономика', 'Gamedev', 'Юмор и сатира', 'Книги о войне', 'Ужасы', 'Языки',
  'Философия', 'Программирование', 'Энциклопедия', 'Мистика', 'Социология', 'Кулинария',
  'Мода и стиль', 'Экология', 'Криминология', 'Финансы', 'Религия', 'Сценарий', 'Сексология',
  'Лингвистика', 'Физика', 'Астрономия', 'Феминизм', 'Фольклор', 'Мифы', 'Античность', 'Йога',
  'Dark akademia', 'Пьеса', 'Нейробиология', 'Русская классика', 'Урбанистика',
  'Литературоведение', 'PR', 'Хоррор', 'Мотивация', 'Риторика', 'Ораторское искусство', 'Музыка',
  'Книги для подростков', 'Домашние животные', 'Легенды', 'Киберпанк', 'Культурология',
  'Автофикшн', 'Документальное', 'ЛГБТК+', 'Сборник', 'HR', 'Спорт', 'Газеты и журналы',
  'Архитектура', 'Реализм', 'Журналистика', 'Магический реализм', 'Переговоры',
  'Философский роман', 'Буддизм', '18+', 'Эротический роман', 'Словари', 'Математика',
  'Информатика', 'Базы данных', 'Косметология', 'Этнография', 'Антропология', 'Бизнес-философия',
  'Вестерн', 'Эссе', 'Эпистолярная литература', 'Астрология', 'Роман-притча', 'Абсурдизм',
  'Арт-эссе', 'Искусствоведение', 'Популярная психология', 'Литературная драма',
  'Документальная проза', 'Личный дневник', 'Философские размышления', 'Эссеистика',
  'Литература свидетельства', 'Self-help', 'Рисунок', 'Производственный роман',
]

export const FALLBACK_LANGUAGES = [
  'Русский', 'Polski', 'Беларуская', 'English', 'Українська', 'Français', 'Italiana', 'Трасянка',
  'Deutsch', 'Łacinka', 'Español',
]

export type Taxonomy = { genres: string[]; languages: string[] }

let cache: Taxonomy | null = null

/** Тесты гоняют несколько баз подряд — кэш между ними жить не должен. */
export function resetTaxonomyCache() {
  cache = null
}

/** Сравнение вариантов «по-человечески»: регистр и пробелы значения не имеют. */
const key = (s: string) => s.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ')

function clean(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    const s = String(v ?? '').trim()
    if (!s || seen.has(key(s))) continue
    seen.add(key(s))
    out.push(s)
  }
  return out
}

/** Справочник из схемы коллекции; пустое свойство — повод остаться на снимке. */
export function taxonomyFromSchema(schema: Schema): Taxonomy {
  const genres = clean(schema.optionsByName?.[GENRE_PROP])
  const languages = clean(schema.optionsByName?.[LANGUAGE_PROP])
  return {
    genres: genres.length ? genres : FALLBACK_GENRES,
    languages: languages.length ? languages : FALLBACK_LANGUAGES,
  }
}

/**
 * Текущий справочник: память → SyncState → снимок. В Notion не ходит (её
 * дёргает только refreshTaxonomy в синке) — ручки должны отвечать быстро.
 */
export async function getTaxonomy(): Promise<Taxonomy> {
  if (cache) return cache
  try {
    const row = await prisma.syncState.findUnique({ where: { key: TAXONOMY_KEY } })
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<Taxonomy>
      const genres = clean(parsed.genres)
      const languages = clean(parsed.languages)
      if (genres.length && languages.length) {
        cache = { genres, languages }
        return cache
      }
    }
  } catch (e: any) {
    console.error('[taxonomy] не прочитал сохранённый справочник:', e?.message ?? e)
  }
  cache = { genres: FALLBACK_GENRES, languages: FALLBACK_LANGUAGES }
  return cache
}

/** Перечитать справочник из Notion и запомнить. Зовётся из синка. */
export async function refreshTaxonomy(): Promise<Taxonomy> {
  const schema = await collectionSchema(env.notion.books.collection, env.notion.books.view)
  const fresh = taxonomyFromSchema(schema)
  cache = fresh
  const value = JSON.stringify(fresh)
  await prisma.syncState.upsert({
    where: { key: TAXONOMY_KEY },
    create: { key: TAXONOMY_KEY, value },
    update: { value },
  })
  return fresh
}

/**
 * Первый прогрев после деплоя: если справочника ещё нет (новая машина, чистая
 * база), тянем его из Notion, не дожидаясь ближайшего синка — иначе формы до
 * 12 часов живут на снимке из кода. Сбой не важен: снимок и так рабочий.
 */
export async function warmTaxonomyOnBoot(delayMs = 10_000) {
  setTimeout(() => {
    void (async () => {
      const row = await prisma.syncState
        .findUnique({ where: { key: TAXONOMY_KEY } })
        .catch(() => null)
      if (row) return
      await refreshTaxonomy().catch((e: any) =>
        console.error('[taxonomy] первый прогрев не удался:', e?.message ?? e),
      )
    })()
  }, delayMs).unref?.()
}

/**
 * Приводит выбранное к справочнику.
 *
 * — значение из справочника берётся в его КАНОНИЧЕСКОМ написании (иначе в Notion
 *   уедет «фентези» и заведёт второй вариант рядом с «Фентези»);
 * — значение, которое уже стоит у книги, сохраняется, даже если его в справочнике
 *   нет: у 33 старых значений («Художка», «Нонфик») своя история, и правка
 *   названия книги не должна молча стирать её жанры;
 * — всё остальное отбрасывается.
 */
export function sanitizeAgainst(values: string[], allowed: string[], keep: string[] = []): string[] {
  const canonical = new Map(allowed.map((a) => [key(a), a]))
  const grandfathered = new Map(keep.map((k) => [key(k), k]))
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of clean(values)) {
    const k = key(raw)
    const value = canonical.get(k) ?? grandfathered.get(k)
    if (!value || seen.has(k)) continue
    seen.add(k)
    out.push(value)
  }
  return out
}

export async function sanitizeGenres(values: string[], keep: string[] = []): Promise<string[]> {
  const { genres } = await getTaxonomy()
  return sanitizeAgainst(values, genres, keep).slice(0, MAX_GENRES)
}

export async function sanitizeLanguages(values: string[], keep: string[] = []): Promise<string[]> {
  const { languages } = await getTaxonomy()
  return sanitizeAgainst(values, languages, keep).slice(0, MAX_LANGUAGES)
}
