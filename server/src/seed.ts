import { prisma } from './db.js'
import { env } from './env.js'

/**
 * Города проекта. Ссылки на городские чаты добавляет админ командой /addgroup,
 * пока ссылки нет — показываем общий чат проекта.
 */
export const CITIES = [
  'Warszawa',
  'Kraków',
  'Wrocław',
  'Poznań',
  'Trójmiasto',
  'Łódź',
  'Białystok',
  'Olsztyn',
  'Radom',
] as const

/** Общий чат проекта — супергруппа с темами по городам. */
export const MAIN_CHAT_ID = -1001856176764n

/** Тема с афишами встреч: оттуда прилетают анонсы. */
export const EVENTS_TOPIC_ID = 14501

/** Тема барахолки: объявления оттуда попадают в Mini App. */
export const MARKET_TOPIC_ID = 4547

/**
 * Городские темы общего чата. Ссылка вида t.me/c/<chat>/<topic> открывается
 * только у участников группы — это нормально, вход в проект через общий чат.
 */
const CITY_TOPICS: Array<[city: string, topic: number]> = [
  ['Warszawa', 3637],
  ['Kraków', 3639],
  ['Wrocław', 3640],
  ['Poznań', 3641],
  ['Trójmiasto', 3638],
  ['Łódź', 3642],
  ['Białystok', 6999],
  ['Olsztyn', 4875],
]

export const INSTAGRAM_URL = 'https://www.instagram.com/mne_ne_zhalko_pl'

const topicUrl = (topic: number) => `https://t.me/c/${String(MAIN_CHAT_ID).replace('-100', '')}/${topic}`

export const eventsTopicUrl = () => topicUrl(EVENTS_TOPIC_ID)

/**
 * Ссылка на САМО сообщение-афишу в теме встреч. Нужна карточке встречи: у
 * разобранных из чата встреч своего `url` обычно нет вовсе (на проде — ни у
 * одной), и нажимать было некуда, хотя первоисточник всегда существует
 * (B4, ТЗ 5.08.2026).
 */
export const eventSourceUrl = (msgId: number | null | undefined): string | null =>
  msgId ? `${topicUrl(EVENTS_TOPIC_ID)}/${msgId}` : null
export const marketTopicUrl = () => topicUrl(MARKET_TOPIC_ID)

/**
 * Заводит общий чат и городские темы. Идемпотентно: строки узнаём по url,
 * поэтому добавление новых городов не плодит дублей и не трогает ручные ссылки.
 */
export async function seedCityGroups() {
  const rows: Array<{ city: string; title: string; url: string; kind: string; sort: number }> = [
    {
      city: 'Все города',
      title: 'МнеНеЖалко в Польше | МнеНеШкада ў Польшчы',
      url: env.mainChatUrl,
      kind: 'chat',
      sort: 0,
    },
    ...CITY_TOPICS.map(([city, topic], i) => ({
      city,
      title: `Книжный чат: ${city}`,
      url: topicUrl(topic),
      kind: 'topic',
      sort: i + 1,
    })),
    {
      city: 'Все города',
      title: 'Афиша встреч',
      url: eventsTopicUrl(),
      kind: 'topic',
      sort: 90,
    },
    {
      city: 'Все города',
      title: 'Барахолка',
      url: marketTopicUrl(),
      kind: 'topic',
      sort: 91,
    },
    {
      city: 'Все города',
      title: 'Инстаграм проекта',
      url: INSTAGRAM_URL,
      kind: 'instagram',
      sort: 99,
    },
  ]

  for (const row of rows) {
    const existing = await prisma.cityGroup.findFirst({ where: { url: row.url } })
    if (existing) {
      await prisma.cityGroup.update({ where: { id: existing.id }, data: row })
    } else {
      await prisma.cityGroup.create({ data: row })
    }
  }
}
