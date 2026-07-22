import crypto from 'node:crypto'
import { env, isAdmin } from './env.js'
import { prisma } from './db.js'

export type TgUser = {
  id: bigint
  username?: string
  firstName?: string
  languageCode?: string
}

/**
 * Проверка Telegram WebApp initData по алгоритму из документации:
 * secret = HMAC_SHA256("WebAppData", bot_token), затем сверяем хеш строки данных.
 */
export function verifyInitData(initData: string): TgUser | null {
  if (!initData) return null
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return null
  params.delete('hash')

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n')

  const secret = crypto.createHmac('sha256', 'WebAppData').update(env.botToken).digest()
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex')

  const a = Buffer.from(computed, 'hex')
  const b = Buffer.from(hash, 'hex')
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

  // не принимаем совсем старые подписи
  const authDate = Number(params.get('auth_date') || 0)
  if (authDate && Date.now() / 1000 - authDate > 86400) return null

  try {
    const user = JSON.parse(params.get('user') || '{}')
    if (!user?.id) return null
    return {
      id: BigInt(user.id),
      username: user.username,
      firstName: user.first_name,
      languageCode: user.language_code,
    }
  } catch {
    return null
  }
}

/** Заводит или обновляет пользователя бота. */
export async function upsertUser(u: TgUser) {
  return prisma.user.upsert({
    where: { tgId: u.id },
    create: {
      tgId: u.id,
      username: u.username,
      firstName: u.firstName,
      lang: u.languageCode?.startsWith('pl') ? 'pl' : 'ru',
      isAdmin: isAdmin(u.id),
      seenAt: new Date(),
    },
    update: {
      username: u.username,
      firstName: u.firstName,
      seenAt: new Date(),
      // единственный источник правды — ADMIN_IDS: убрали из окружения, значит
      // прав нет и в API (раньше флаг в базе только выставлялся и не снимался)
      isAdmin: isAdmin(u.id),
    },
  })
}
