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
import { logModeration, queueNotice } from './moderation.js'
import { lookupPlace } from './agglomeration.js'
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
    district: { type: 'string', description: 'Район ГОРОДА, если назван (Wola, Mokotów), иначе пустая строка' },
    locality: {
      type: 'string',
      description:
        'Отдельный населённый пункт, если он назван и его нет в списке городов проекта ' +
        '(пригород, посёлок, город рядом) — как написано в тексте; иначе пустая строка',
    },
  },
  required: ['isOffer', 'kind', 'title', 'description', 'price', 'city', 'district', 'locality'],
  additionalProperties: false,
} as const

export type ParsedOffer = {
  kind: 'give' | 'sell' | 'search'
  title: string
  description: string | null
  price: string | null
  city: string
  district: string | null
  /** Населённый пункт, если это не сам город проекта: «Wieliczka» при городе Kraków. */
  locality: string | null
}

const NO_CITY = 'Все города'

/**
 * Приводит место объявления к городу проекта по справочнику агломераций.
 *
 * Отдельная функция без сети — на ней и держится правило «привязку даёт только
 * справочник»: модель называет населённый пункт, город назначаем мы.
 *
 * Разбор идёт по убыванию доверия: сначала поле города, потом населённый пункт,
 * потом район. Район проверяется потому, что так это и случилось на живом
 * объявлении 30 июля: «Величка» приехала именно в `district`.
 */
export function resolvePlace(p: { city?: string; district?: string | null; locality?: string | null }): {
  city: string
  district: string | null
  locality: string | null
} {
  const district = p.district?.trim() || null

  for (const source of ['city', 'locality', 'district'] as const) {
    const raw = source === 'city' ? p.city : source === 'locality' ? p.locality : district
    const hit = lookupPlace(raw)
    if (!hit?.city) continue
    return {
      city: hit.city,
      // название, по которому нашли город, из района убираем: иначе оно
      // попадёт и в заголовок карточки, и в подпись «Kraków (Wieliczka)»
      district: source === 'district' ? null : district,
      locality: hit.locality === hit.city ? null : hit.locality,
    }
  }

  // города в справочнике нет: не выдумываем ближайший, объявление живёт
  // в разделе «Все города», а сам населённый пункт сохраняем как написали
  const unknown = lookupPlace(p.locality) ?? lookupPlace(p.city)
  return { city: NO_CITY, district, locality: unknown?.locality ?? null }
}

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
      'Город выбирай ТОЛЬКО из списка: ' + CITIES.join(', ') + '. ' +
      'Если названный населённый пункт в списке не значится — оставь city пустым, ' +
      'а название напиши в locality как есть. Ближайший город НЕ подбирай: ' +
      'привязку к городу делаем не мы. Если места нет вовсе — обе строки пустые. ' +
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
      locality: string
    }
    if (!p.isOffer || !p.title.trim()) return null
    const place = resolvePlace({ city: p.city, district: p.district, locality: p.locality })
    return {
      kind: ['give', 'sell', 'search'].includes(p.kind) ? p.kind : 'give',
      title: p.title.trim().slice(0, 120),
      description: p.description?.trim().slice(0, 1000) || null,
      price: p.price?.trim().slice(0, 50) || null,
      city: place.city,
      district: place.district?.slice(0, 80) || null,
      locality: place.locality?.slice(0, 80) || null,
    }
  } catch {
    return null
  }
}

/** Срок жизни объявления: барахолка не должна показывать прошлогодние посты. */
export const MARKET_TTL_DAYS = 45
const day = 86_400_000

/**
 * Закрывает протухшие объявления. У старых строк без expiresAt срок считается
 * от bumpedAt. Продление — новый пост в теме барахолки (появится свежая
 * карточка). Возвращает закрытые, чтобы бот мог предупредить авторов.
 */
export async function expireMarketItems(now = new Date()) {
  const legacyCutoff = new Date(now.getTime() - MARKET_TTL_DAYS * day)
  const stale = await prisma.marketItem.findMany({
    where: {
      status: 'active',
      OR: [
        { expiresAt: { lt: now } },
        { expiresAt: null, bumpedAt: { lt: legacyCutoff } },
      ],
    },
    select: { id: true, title: true, authorTg: true },
  })
  if (stale.length) {
    await prisma.marketItem.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: { status: 'closed' },
    })
  }
  return { closed: stale.length, items: stale }
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
      // пригород — отдельным полем, а не приписью к заголовку: по нему
      // объявление находится фильтром города и подписывается «Kraków (Wieliczka)»
      locality: offer.locality,
      kind: offer.kind,
      title: offer.district ? `${offer.title} (${offer.district})` : offer.title,
      description: offer.description,
      price: offer.price,
      photo: msg.photo ?? null,
      status: 'active',
      expiresAt: new Date(Date.now() + MARKET_TTL_DAYS * day),
      source: 'topic',
      sourceMsgId: msg.id,
      authorTg: msg.authorTg,
      authorUsername: msg.authorUsername ?? null,
    },
  })
}

/* ── снятие объявления модератором ────────────────────────── */

/**
 * Убрать карточку барахолки.
 *
 * До 30 июля 2026 убрать объявление было НЕЧЕМ: статус меняли только джоба
 * протухания (45 дней) и удаление профиля автора. То есть спамная или ошибочная
 * карточка висела в витрине до конца срока. Удаление исходного сообщения в теме
 * не помогает вовсе: Bot API не присылает событий об удалении, бот о нём не
 * узнаёт.
 *
 * Строка НЕ удаляется физически: `removed` оставляет возможность вернуть
 * объявление и сохраняет объяснимый след в журнале. Причина обязательна — её
 * увидит автор.
 *
 * Ищем либо по `id`, либо по исходному сообщению (ответ на пост в теме).
 * ⚠️ У `MarketItem` нет колонки с чатом, поэтому «свой» чат проверяет вызывающий
 * (бот сверяет `ctx.chat.id` с MAIN_CHAT_ID). Колонка появится вместе с импортом
 * истории, где дедуп нужен по паре чат+сообщение (docs/TECH_DEBT.md).
 */
export async function removeMarketItem(opts: {
  actorTg: bigint
  id?: string
  sourceMsgId?: number
  reason: string
}): Promise<
  | { ok: true; item: { id: string; title: string; authorTg: bigint }; notice: string }
  | { ok: false; code: 'no_reason' | 'not_found' | 'already_removed' }
> {
  const reason = opts.reason.trim().slice(0, 300)
  if (!reason) return { ok: false, code: 'no_reason' }

  const found = opts.id
    ? await prisma.marketItem.findUnique({ where: { id: opts.id } })
    : opts.sourceMsgId !== undefined
      ? await prisma.marketItem.findFirst({ where: { sourceMsgId: opts.sourceMsgId } })
      : null
  if (!found) return { ok: false, code: 'not_found' }

  const notice = `Ваше объявление «${found.title}» снято модератором. Причина: ${reason}.`

  const outcome = await prisma.$transaction(async (tx) => {
    /**
     * Переход УСЛОВНЫЙ, решает число изменённых строк: два админа могут снять
     * одну карточку одновременно, и «прочитал состояние → записал» дало бы две
     * записи в журнале и два письма автору об одном и том же.
     */
    const changed = await tx.marketItem.updateMany({
      where: { id: found.id, status: 'active' },
      data: { status: 'removed' },
    })
    if (!changed.count) return 'already_removed' as const

    // журнал и письмо — в той же транзакции: сбой любого из них откатывает
    // и снятие, иначе объявление исчезло бы без объяснения и без следа
    await logModeration(tx, {
      actorTg: opts.actorTg,
      targetUserTg: found.authorTg,
      targetType: 'market',
      targetId: found.id,
      action: 'remove',
      reason,
      // в журнал кладём только то, что и так в самой карточке: ни ника, ни id
      meta: { title: found.title, city: found.city },
    })
    // автор у объявления есть всегда (в схеме связь обязательна), поэтому
    // письмо кладём без условий — молча снятая карточка выглядела бы пропажей
    await queueNotice(tx, found.authorTg, notice)
    return 'ok' as const
  })
  if (outcome !== 'ok') return { ok: false, code: outcome }

  return { ok: true, item: { id: found.id, title: found.title, authorTg: found.authorTg }, notice }
}
