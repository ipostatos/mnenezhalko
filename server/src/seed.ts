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

export async function seedCityGroups() {
  const existing = await prisma.cityGroup.count()
  if (existing > 0) return
  await prisma.cityGroup.create({
    data: {
      city: 'Все города',
      title: 'МнеНеЖалко в Польше | МнеНеШкада ў Польшчы',
      url: env.mainChatUrl,
      kind: 'chat',
      sort: 0,
    },
  })
}
