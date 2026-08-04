/**
 * Справочник агломераций: пригород → город проекта.
 *
 * Зачем. 30 июля 2026 на первом живом объявлении барахолки «Величка» (Wieliczka
 * под Краковом) уехала в район, а городом стало «Все города». Человек с фильтром
 * «только Kraków» это объявление не увидел.
 *
 * Почему справочником, а не «ближайшим городом» и не моделью (решение владельца
 * проекта):
 *  - ближайший по расстоянию город не обязательно тот, с которым связана
 *    транспортная агломерация;
 *  - названия населённых пунктов в Польше повторяются (Michałowice есть и под
 *    Варшавой, и под Краковом) — угадать по названию нельзя в принципе;
 *  - посёлок бывает ровно между двумя городами проекта;
 *  - модель уверенно придумает привязку, которой нет.
 *
 * Поэтому привязка появляется ТОЛЬКО из записи в этом файле. Нет записи —
 * населённый пункт сохраняется как есть (`locality`), объявление живёт в разделе
 * «Все города». Это честнее, чем показать человеку неверный город.
 *
 * Названия-двойники ловятся при сборке индекса и выбрасываются из него (см.
 * AMBIGUOUS): встретив такое имя, мы обязаны признать, что не знаем города.
 */
import { CITIES } from './seed.js'

/** Города проекта, вокруг которых собраны пригороды. */
type ProjectCity = (typeof CITIES)[number]

/**
 * Пригороды и города-спутники. Список ручной и заведомо неполный: пополняется
 * по мере того, как в барахолке появляются реальные населённые пункты.
 * Внутри города — по алфавиту.
 */
const SATELLITES: Record<ProjectCity, string[]> = {
  Warszawa: [
    'Brwinów',
    'Grodzisk Mazowiecki',
    'Józefów',
    'Konstancin-Jeziorna',
    'Legionowo',
    'Łomianki',
    'Marki',
    'Michałowice', // двойник: есть и под Краковом — индекс его выбросит
    'Milanówek',
    'Nadarzyn',
    'Ożarów Mazowiecki',
    'Piaseczno',
    'Piastów',
    'Podkowa Leśna',
    'Pruszków',
    'Raszyn',
    'Sulejówek',
    'Wołomin',
    'Ząbki',
    'Zielonka',
    'Otwock',
  ],
  Kraków: [
    'Krzeszowice',
    'Liszki',
    'Michałowice', // двойник, см. выше
    'Myślenice',
    'Niepołomice',
    'Skawina',
    'Świątniki Górne',
    'Wieliczka',
    'Zabierzów',
    'Zielonki',
  ],
  Wrocław: [
    'Bielany Wrocławskie',
    'Długołęka',
    'Kąty Wrocławskie',
    'Kobierzyce',
    'Oborniki Śląskie',
    'Oleśnica',
    'Siechnice',
    'Smolec',
    'Trzebnica',
  ],
  Poznań: [
    'Czerwonak',
    'Dopiewo',
    'Komorniki',
    'Kórnik',
    'Luboń',
    'Mosina',
    'Murowana Goślina',
    'Puszczykowo',
    'Suchy Las',
    'Swarzędz',
    'Tarnowo Podgórne',
  ],
  /** Trójmiasto — сам по себе агломерация: три города проекта плюс пояс. */
  Trójmiasto: [
    'Gdańsk',
    'Gdynia',
    'Kolbudy',
    'Pruszcz Gdański',
    'Reda',
    'Rumia',
    'Sopot',
    'Straszyn',
    'Wejherowo',
    'Żukowo',
  ],
  Łódź: [
    'Aleksandrów Łódzki',
    'Konstantynów Łódzki',
    'Ozorków',
    'Pabianice',
    'Rzgów',
    'Stryków',
    'Zgierz',
  ],
  Białystok: ['Choroszcz', 'Juchnowiec Kościelny', 'Łapy', 'Supraśl', 'Wasilków', 'Zabłudów'],
  Olsztyn: ['Barczewo', 'Dobre Miasto', 'Dywity', 'Jonkowo', 'Purda', 'Stawiguda'],
  Radom: ['Jedlnia-Letnisko', 'Kowala', 'Skaryszew'],
}

/**
 * Кириллические и разговорные написания. Слева — как пишет человек, справа —
 * запись из справочника выше или город проекта. Тоже только явные пары: списка
 * правил транслитерации здесь нет намеренно, они дают ложные совпадения.
 */
const ALIASES: Record<string, string> = {
  // города проекта
  Варшава: 'Warszawa',
  Краков: 'Kraków',
  Вроцлав: 'Wrocław',
  Познань: 'Poznań',
  Лодзь: 'Łódź',
  Белосток: 'Białystok',
  Ольштын: 'Olsztyn',
  Радом: 'Radom',
  Труймясто: 'Trójmiasto',
  Трёхградье: 'Trójmiasto',
  Трехградье: 'Trójmiasto',
  // пояс Трёхградья
  Гданьск: 'Gdańsk',
  Гдыня: 'Gdynia',
  Сопот: 'Sopot',
  Румя: 'Rumia',
  Реда: 'Reda',
  Вейхерово: 'Wejherowo',
  'Прущ-Гданьски': 'Pruszcz Gdański',
  // под Краковом
  Величка: 'Wieliczka',
  Скавина: 'Skawina',
  Неполомице: 'Niepołomice',
  Мысленице: 'Myślenice',
  // под Варшавой
  Прушкув: 'Pruszków',
  Прушков: 'Pruszków',
  Пясечно: 'Piaseczno',
  Легионово: 'Legionowo',
  Зомбки: 'Ząbki',
  Воломин: 'Wołomin',
  Отвоцк: 'Otwock',
  Юзефув: 'Józefów',
  Юзефов: 'Józefów',
  Ломянки: 'Łomianki',
  Констанцин: 'Konstancin-Jeziorna',
  // под Познанью и Вроцлавом
  Лубонь: 'Luboń',
  Сважендз: 'Swarzędz',
  Олесница: 'Oleśnica',
  Тшебница: 'Trzebnica',
  Сехнице: 'Siechnice',
  // под Лодзью и Белостоком
  Пабянице: 'Pabianice',
  Згеж: 'Zgierz',
  Василькув: 'Wasilków',
  Супрасль: 'Supraśl',
}

/**
 * Ключ для сравнения написаний: регистр, диакритика, дефисы и лишние пробелы
 * не должны мешать узнаванию. ⚠️ `ł` под NFD НЕ раскладывается (это отдельная
 * буква, а не l с надстрочным знаком) — заменяем руками, иначе «Łomianki»
 * и «Lomianki» останутся разными ключами.
 */
export function normalizePlace(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // надстрочные знаки после разложения
    .replace(/[Łł]/g, 'l') // Ł и ł
    .toLowerCase()
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Имена, встречающиеся больше чем у одного города: привязку по ним не даём. */
export const AMBIGUOUS = new Set<string>()

/** normalizePlace(название) → { город проекта, каноническое написание }. */
const INDEX = new Map<string, { city: ProjectCity; canonical: string }>()

for (const city of CITIES) {
  // сам город проекта: «Kraków» → Kraków без пригорода
  INDEX.set(normalizePlace(city), { city, canonical: city })
}
for (const [city, places] of Object.entries(SATELLITES) as Array<[ProjectCity, string[]]>) {
  for (const place of places) {
    const key = normalizePlace(place)
    const seen = INDEX.get(key)
    if (seen && seen.city !== city) {
      // двойник: под двумя городами проекта. Уверенной привязки нет ни у нас,
      // ни у человека, который написал одно слово — убираем из справочника.
      INDEX.delete(key)
      AMBIGUOUS.add(key)
      continue
    }
    if (AMBIGUOUS.has(key)) continue
    INDEX.set(key, { city, canonical: place })
  }
}
for (const [alias, target] of Object.entries(ALIASES)) {
  const hit = INDEX.get(normalizePlace(target))
  if (!hit) continue // цель оказалась двойником — псевдоним тоже не привязываем
  INDEX.set(normalizePlace(alias), hit)
}

export type PlaceMatch = {
  /** Город проекта или null, если в справочнике такой записи нет. */
  city: ProjectCity | null
  /** Каноническое написание населённого пункта; у неизвестного — как написали. */
  locality: string
  /** true, если название встречается у двух городов проекта. */
  ambiguous: boolean
}

/**
 * Ищет населённый пункт в справочнике.
 *
 * Возвращает `city: null` в двух разных случаях — записи нет и запись двойная;
 * различие видно по `ambiguous` и нужно только для объяснений и тестов, решение
 * в обоих случаях одно: города мы не знаем.
 */
export function lookupPlace(raw: string | null | undefined): PlaceMatch | null {
  const value = (raw ?? '').trim()
  if (!value) return null
  const key = normalizePlace(value)
  if (!key) return null
  const hit = INDEX.get(key)
  if (hit) return { city: hit.city, locality: hit.canonical, ambiguous: false }
  return { city: null, locality: value.slice(0, 80), ambiguous: AMBIGUOUS.has(key) }
}

/** «Kraków (Wieliczka)» — город проекта и, если он не сам город, пригород. */
export function describePlace(city: string, locality: string | null | undefined): string {
  if (!locality) return city
  return normalizePlace(locality) === normalizePlace(city) ? city : `${city} (${locality})`
}

/** Для тестов и админских отчётов: сколько названий знает справочник. */
export const PLACES_KNOWN = INDEX.size
