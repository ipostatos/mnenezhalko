/**
 * Барахолка из чата проекта.
 *
 * В общем чате есть тема «Барахолка»: люди кидают фото вещи и пишут свободным
 * текстом — «отдам стеллаж, Варшава, Воля, самовывоз». Разбираем такой пост в
 * карточку: тип (отдам/продам/ищу), заголовок, цена, город, автор — и показываем
 * ровной сеткой в Mini App и в /baraholka.
 */
import Anthropic from '@anthropic-ai/sdk'
import { env } from './env.js'
import { prisma } from './db.js'
import { CITIES } from './seed.js'

const client = env.anthropicKey ? new Anthropic({ apiKey: env.anthropicKey }) : null

const SCHEMA = {
  type: 'object',
  properties: {
    isOffer: { type: 'boolean', description: 'true, если это объявление, а не болтовня' },
    kind: { type: 'string', enum: ['give', 'sell', 'search'] },
    title: { type: 'string', description: 'Коротко, что за вещь — до 60 знаков' },
    description: { type: 'string', description: 'Одно-два предложения: состояние, детали, условия' },
    price: { type: 'string', description: 'Цена как в тексте («50 zł», «даром»); пустая строка, если не указана' },
    city: { type: 'string', description: 'Город из списка или пустая строка' },
    district: { type: 'string', description: 'Район, если назван, иначе пустая строка' },
  },
  required: ['isOffer', 'kind', 'title', 'description', 'price', 'city', 'district'],
  additionalProperties: false,
} as const

export type ParsedOffer = {
  kind: 'give' | 'sell' | 'search'
  title: string
  description: string | null
  price: string | null
  city: string
  district: string | null
}

const NO_CITY = 'Все города'

/** Разбирает пост барахолки. Пустой результат — значит не объявление. */
export async function parseOffer(text: string): Promise<ParsedOffer | null> {
  if (!client || text.trim().length < 8) return null

  const res = await client.messages.create({
    model: env.anthropicModel,
    max_tokens: 700,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: SCHEMA },
    },
    system:
      'Ты разбираешь объявления барахолки книжного сообщества «МнеНеЖалко» в Польше. ' +
      'Определи тип: give — отдают даром, sell — продают, search — ищут/куплю.\n' +
      'Заголовок пиши сам, коротко и по-человечески, без эмодзи и капса. ' +
      'Цену бери из текста как есть, ничего не выдумывай. ' +
      'Город выбирай ТОЛЬКО из списка: ' + CITIES.join(', ') + ' ' +
      '(Gdańsk, Gdynia, Sopot → Trójmiasto). Если города нет — пустая строка. ' +
      'Если это не объявление (вопрос, спасибо, обсуждение) — isOffer = false.',
    messages: [{ role: 'user', content: text.slice(0, 2000) }],
  })

  const out = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')

  try {
    const p = JSON.parse(out) as {
      isOffer: boolean
      kind: ParsedOffer['kind']
      title: string
      description: string
      price: string
      city: string
      district: string
    }
    if (!p.isOffer || !p.title.trim()) return null
    return {
      kind: ['give', 'sell', 'search'].includes(p.kind) ? p.kind : 'give',
      title: p.title.trim().slice(0, 120),
      description: p.description?.trim().slice(0, 1000) || null,
      price: p.price?.trim().slice(0, 50) || null,
      city: CITIES.includes(p.city as (typeof CITIES)[number]) ? p.city : NO_CITY,
      district: p.district?.trim().slice(0, 80) || null,
    }
  } catch {
    return null
  }
}

/** Сохраняет объявление из темы, если такого ещё нет. */
export async function saveOffer(
  offer: ParsedOffer,
  msg: { id: number; authorTg: bigint; authorUsername?: string | null; firstName?: string | null; photo?: string | null },
) {
  const already = await prisma.marketItem.findFirst({ where: { sourceMsgId: msg.id } })
  if (already) return null

  await prisma.user.upsert({
    where: { tgId: msg.authorTg },
    create: {
      tgId: msg.authorTg,
      username: msg.authorUsername ?? null,
      firstName: msg.firstName ?? null,
    },
    update: { username: msg.authorUsername ?? undefined },
  })

  return prisma.marketItem.create({
    data: {
      city: offer.city,
      kind: offer.kind,
      title: offer.district ? `${offer.title} (${offer.district})` : offer.title,
      description: offer.description,
      price: offer.price,
      photo: msg.photo ?? null,
      status: 'active',
      source: 'topic',
      sourceMsgId: msg.id,
      authorTg: msg.authorTg,
      authorUsername: msg.authorUsername ?? null,
    },
  })
}
