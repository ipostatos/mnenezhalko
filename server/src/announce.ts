/**
 * Афиши встреч из чата проекта.
 *
 * В общем чате есть тема «Афиша встреч»: люди пишут анонсы свободным текстом
 * («Варшава, 3 августа в 18:30, книжный обмен в кафе…»). Разбираем такой текст
 * в структуру, заводим встречу и шлём алерт тем, кто ждёт события своего города.
 */
import Anthropic from '@anthropic-ai/sdk'
import { env } from './env.js'
import { prisma } from './db.js'
import { CITIES } from './seed.js'
import { warsawTime } from './time.js'

const client = env.anthropicKey ? new Anthropic({ apiKey: env.anthropicKey }) : null

const SCHEMA = {
  type: 'object',
  properties: {
    isAnnouncement: {
      type: 'boolean',
      description: 'true, если это анонс конкретной встречи с датой',
    },
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'Город строго из списка' },
          date: { type: 'string', description: 'Дата в формате YYYY-MM-DD' },
          time: { type: 'string', description: 'Время HH:MM, если указано, иначе пустая строка' },
          title: { type: 'string', description: 'Короткое название встречи' },
          place: { type: 'string', description: 'Место: кафе, адрес; пустая строка, если нет' },
          description: { type: 'string', description: 'Одно предложение о встрече' },
        },
        required: ['city', 'date', 'time', 'title', 'place', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['isAnnouncement', 'events'],
  additionalProperties: false,
} as const

export type ParsedEvent = {
  city: string
  startsAt: Date
  title: string
  place: string | null
  description: string | null
}

/** Разбирает текст афиши. Возвращает пустой массив, если это не анонс. */
export async function parseAnnouncement(text: string, now = new Date()): Promise<ParsedEvent[]> {
  if (!client || text.trim().length < 15) return []

  const res = await client.messages.create({
    model: env.anthropicModel,
    max_tokens: 1000,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: SCHEMA },
    },
    system:
      'Ты разбираешь анонсы встреч книжного проекта «МнеНеЖалко» в Польше. ' +
      'Из текста достань встречи: город, дату, время, название, место.\n' +
      `Сегодня ${now.toISOString().slice(0, 10)}, часовой пояс Europe/Warsaw. ` +
      'Если год не указан — бери ближайший будущий. Если даты нет вовсе или это ' +
      'обсуждение, а не анонс, ставь isAnnouncement = false и пустой список.\n' +
      'Город выбирай ТОЛЬКО из списка: ' + CITIES.join(', ') + '. ' +
      'Gdańsk, Gdynia и Sopot — это Trójmiasto.',
    messages: [{ role: 'user', content: text.slice(0, 3000) }],
  })

  const out = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')

  try {
    const parsed = JSON.parse(out) as {
      isAnnouncement: boolean
      events: { city: string; date: string; time: string; title: string; place: string; description: string }[]
    }
    if (!parsed.isAnnouncement) return []
    return parsed.events
      .filter((e) => CITIES.includes(e.city as (typeof CITIES)[number]) && /^\d{4}-\d{2}-\d{2}$/.test(e.date))
      .map((e) => {
        const time = /^\d{2}:\d{2}$/.test(e.time) ? e.time : '19:00'
        // варшавское время с учётом CET/CEST — не захардкоженное +02:00
        const startsAt = warsawTime(e.date, time)
        return {
          city: e.city,
          startsAt,
          title: e.title.slice(0, 200) || 'Встреча МнеНеЖалко',
          place: e.place?.slice(0, 200) || null,
          description: e.description?.slice(0, 1000) || null,
        }
      })
      .filter((e) => !Number.isNaN(e.startsAt.getTime()) && e.startsAt.getTime() > now.getTime() - 12 * 3600_000)
  } catch {
    return []
  }
}

/**
 * Заводит встречу из афиши. Одно сообщение может нести НЕСКОЛЬКО встреч,
 * поэтому ключ дедупа — (sourceMsgId, index), а не только id сообщения:
 * старый дедуп по msgId молча глотал все встречи, кроме первой.
 * Повторный разбор того же сообщения обновляет свою запись (правка афиши),
 * но не создаёт дубль и не шлёт повторный алерт (создание возвращает Event,
 * обновление и дубль — null).
 */
export async function saveAnnouncement(e: ParsedEvent, msgId: number, index = 0) {
  const bySource = await prisma.event.findFirst({
    where: { sourceMsgId: msgId, sourceEventIndex: index },
  })
  if (bySource) {
    const changed =
      bySource.city !== e.city ||
      bySource.startsAt.getTime() !== e.startsAt.getTime() ||
      bySource.title !== e.title ||
      bySource.place !== (e.place ?? null) ||
      bySource.description !== (e.description ?? null)
    if (changed) {
      await prisma.event.update({
        where: { id: bySource.id },
        data: {
          city: e.city,
          title: e.title,
          startsAt: e.startsAt,
          place: e.place,
          description: e.description,
        },
      })
    }
    return null
  }
  // ту же встречу мог руками завести админ — не плодим копию
  const duplicate = await prisma.event.findFirst({
    where: { city: e.city, startsAt: e.startsAt, title: e.title },
  })
  if (duplicate) return null
  return prisma.event.create({
    data: {
      city: e.city,
      title: e.title,
      startsAt: e.startsAt,
      place: e.place,
      description: e.description,
      source: 'topic',
      sourceMsgId: msgId,
      sourceEventIndex: index,
    },
  })
}
