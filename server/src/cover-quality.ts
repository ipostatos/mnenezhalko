/**
 * «Обложка есть, но смотреть не на что»: часть внешних магазинов на месте
 * отсутствующей картинки отдаёт НАСТОЯЩИЙ файл-заглушку — серый прямоугольник
 * с иконкой фотоаппарата и надписью «Brak zdjęcia». Такой ответ приходит с
 * кодом 200 и Content-Type image/*, поэтому ни `onError` в браузере, ни любая
 * проверка «загрузилась ли картинка» его не ловят: в витрине появляется пустая
 * карточка (жалоба user 5.08.2026, A3).
 *
 * ПОЧЕМУ НЕ СПИСОК ХОСТОВ И НЕ СПИСОК URL. Заглушку отдаёт не «плохой» домен, а
 * конкретная страница на обычном хосте (`ecsmedia.pl` — CDN Empik, на проде так
 * пришли 54 книги), и завтра то же самое сделает следующий магазин. Признак
 * надёжнее искать в самой картинке.
 *
 * ЗАМЕР НА ПРОДЕ (500 файлов кэша превью, сплошной выборкой):
 *   заглушки          энтропия 0.31–0.88, максимальный разброс канала 2.8–3.8
 *   ближайшая обложка энтропия 1.87,      разброс 17.4
 *   медиана каталога  энтропия 6.67
 * Отсюда два признака сразу и с запасом: почти нет деталей И почти нет цвета.
 * Одной энтропии мало — тёмная или очень минималистичная обложка тоже бывает
 * низкоэнтропийной, но она не бывает при этом ещё и одноцветной.
 */
import sharp from 'sharp'
import { prisma } from './db.js'

/** Порог «деталей нет». Ниже — только заглушки (ближайшая настоящая обложка: 1.87). */
export const STUB_MAX_ENTROPY = 1.5
/** Порог «цвета нет»: максимальный разброс по каналу (заглушки 2.8–3.8, обложки от 17). */
export const STUB_MAX_STDEV = 12

/**
 * Похоже ли изображение на «нет картинки». Считается по УЖЕ уменьшенному
 * превью: во-первых, дешевле (файл в десятки раз меньше оригинала), во-вторых,
 * пороги выше сняты именно с превью — мерить надо то же, что и калибровали.
 * Ошибку разбора глотаем: «не смогли посмотреть» — это не «заглушка».
 */
export async function looksLikeStubCover(image: Buffer): Promise<boolean> {
  try {
    const stats = await sharp(image).stats()
    const stdev = Math.max(...stats.channels.map((c) => c.stdev))
    return stats.entropy < STUB_MAX_ENTROPY && stdev < STUB_MAX_STDEV
  } catch {
    return false
  }
}

/**
 * Реестр найденных заглушек — чтобы витрина карусели их не выбирала ВООБЩЕ, а
 * не показывала дырку и надеялась на `onError` у клиента. Список маленький по
 * своей природе (одна заглушка на магазин — это десятки url, не тысячи), поэтому
 * лежит одной строкой в SyncState, без своей таблицы и без миграции.
 *
 * Живёт между деплоями: каталог обходится прогревом (prewarm.ts) и обычными
 * заходами людей, и заново переучиваться после каждого релиза было бы обидно.
 */
const STUB_KEY = 'cover:stub-urls'
const STUB_MAX = 2000 // потолок строки: дальше вытесняем самые старые записи
const CACHE_TTL_MS = 60_000

let cache: { at: number; urls: Set<string> } | null = null

export async function stubCoverUrls(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.urls
  const row = await prisma.syncState.findUnique({ where: { key: STUB_KEY } }).catch(() => null)
  let urls: string[] = []
  if (row) {
    try {
      const parsed = JSON.parse(row.value)
      if (Array.isArray(parsed)) urls = parsed.filter((u) => typeof u === 'string')
    } catch {
      /* мусор в строке — начнём список заново, это всего лишь кэш знания */
    }
  }
  cache = { at: Date.now(), urls: new Set(urls) }
  return cache.urls
}

/** Запомнить, что по этому адресу лежит заглушка. Идемпотентно. */
export async function rememberStubCover(url: string): Promise<void> {
  const known = await stubCoverUrls()
  if (known.has(url)) return
  known.add(url)
  const list = [...known].slice(-STUB_MAX)
  cache = { at: Date.now(), urls: new Set(list) }
  await prisma.syncState
    .upsert({
      where: { key: STUB_KEY },
      create: { key: STUB_KEY, value: JSON.stringify(list) },
      update: { value: JSON.stringify(list) },
    })
    .catch(() => {})
}

/** Сброс памяти процесса — нужен тестам и ручной чистке реестра. */
export function forgetStubCoverCache(): void {
  cache = null
}
