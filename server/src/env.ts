import 'dotenv/config'

function req(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Не задана переменная окружения ${name}`)
  return v
}

export const env = {
  botToken: req('BOT_TOKEN'),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  botMode: (process.env.BOT_MODE || 'polling') as 'polling' | 'webhook',
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',

  notion: {
    spaceId: process.env.NOTION_SPACE_ID || '5918928c-3188-457e-a69e-961acdc128e3',
    books: {
      collection: process.env.NOTION_BOOKS_COLLECTION || '53f0bd43-f6da-419b-9f38-f769d828c3c5',
      view: process.env.NOTION_BOOKS_VIEW || 'efab27f6-9f91-4b37-8b72-b20178b88f9c',
    },
    librarians: {
      collection: process.env.NOTION_LIBRARIANS_COLLECTION || 'c75bfeab-27de-4b18-89ff-22f1775a7d22',
      view: process.env.NOTION_LIBRARIANS_VIEW || 'ee305902-186b-4678-bc21-66899f807a72',
    },
    games: {
      collection: process.env.NOTION_GAMES_COLLECTION || '1c144aab-976e-4488-b090-6079c9bc109f',
      view: process.env.NOTION_GAMES_VIEW || '46806d71-df83-4412-9270-bde93c4692b8',
    },
    syncHours: Number(process.env.NOTION_SYNC_HOURS || 12),
  },

  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',

  adminIds: (process.env.ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => BigInt(s)),

  mainChatUrl: process.env.MAIN_CHAT_URL || 'https://t.me/+hlRk_HGIDcE4M2Vi',
}

export const isAdmin = (tgId: bigint | number) =>
  env.adminIds.some((id) => id === BigInt(tgId))
