/**
 * Импорт истории темы из выгрузки Telegram Desktop.
 *
 * Bot API не отдаёт прошлые сообщения: бот видит только то, что написано после
 * его добавления в чат. Поэтому старые объявления барахолки и афиши переносим
 * из экспорта — Telegram Desktop → ⋮ → «Экспорт истории чата» → формат JSON
 * (с фото, если нужны картинки).
 *
 *   npm run import -w server -- <result.json> --mode market --topic 4547
 *   npm run import -w server -- <result.json> --mode events --topic 14501 --dry
 */
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { prisma } from './db.js'
import { COVERS_DIR, coverUrlOf } from './covers.js'
import { parseOffer, saveOffer } from './market.js'
import { parseAnnouncement, saveAnnouncement } from './announce.js'

type Raw = {
  id: number
  type?: string
  date?: string
  from?: string
  from_id?: string
  text?: unknown
  text_entities?: { type: string; text: string }[]
  photo?: string
  reply_to_message_id?: number
  topic_id?: number
  action?: string
}

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const mode = (flag('mode') ?? 'market') as 'market' | 'events'
const topic = flag('topic') ? Number(flag('topic')) : undefined
const limit = Number(flag('limit') ?? 200)
const dry = args.includes('--dry')

if (!file) {
  console.error('Укажите путь к result.json из экспорта Telegram Desktop.')
  process.exit(1)
}

/** Текст сообщения: экспорт кладёт его строкой либо массивом кусочков. */
function textOf(m: Raw): string {
  if (typeof m.text === 'string') return m.text
  if (Array.isArray(m.text)) {
    return m.text.map((p: any) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('')
  }
  if (m.text_entities?.length) return m.text_entities.map((e) => e.text).join('')
  return ''
}

/**
 * Сообщения нужной темы. В экспорте тема отмечается `topic_id`, а в старых
 * версиях — цепочкой ответов на корневое сообщение темы.
 */
function inTopic(m: Raw, all: Raw[]): boolean {
  if (!topic) return true
  if (m.topic_id) return m.topic_id === topic
  if (m.id === topic) return false
  if (m.reply_to_message_id === topic) return true
  // ответ внутри темы: поднимаемся по цепочке
  const byId = new Map(all.map((x) => [x.id, x]))
  let cur = m
  for (let i = 0; i < 20 && cur.reply_to_message_id; i++) {
    if (cur.reply_to_message_id === topic) return true
    const next = byId.get(cur.reply_to_message_id)
    if (!next) break
    cur = next
  }
  return false
}

const root = path.dirname(path.resolve(file))
const raw = JSON.parse(await readFile(file, 'utf8')) as { messages?: Raw[]; id?: number }
const all = raw.messages ?? []
const messages = all
  .filter((m) => (m.type ?? 'message') === 'message' && !m.action)
  .filter((m) => inTopic(m, all))
  .slice(-limit)

console.log(
  `в выгрузке ${all.length} сообщений, к разбору ${messages.length}` +
    (topic ? ` (тема ${topic})` : '') +
    (dry ? ' — сухой прогон' : ''),
)

/** Фото из выгрузки кладём рядом с обложками и отдаём своей ссылкой. */
async function importPhoto(m: Raw): Promise<string | null> {
  if (!m.photo) return null
  const from = path.resolve(root, m.photo)
  const ext = path.extname(from) || '.jpg'
  const name = `import-${m.id}${ext}`
  try {
    await mkdir(COVERS_DIR, { recursive: true })
    await copyFile(from, path.join(COVERS_DIR, name))
    return coverUrlOf(name)
  } catch {
    console.warn(`   фото не нашлось: ${m.photo}`)
    return null
  }
}

let ok = 0
let skipped = 0

for (const m of messages) {
  const text = textOf(m).trim()
  if (text.length < 8) {
    skipped++
    continue
  }
  const who = m.from ?? 'без имени'

  if (mode === 'events') {
    const events = await parseAnnouncement(text, m.date ? new Date(m.date) : undefined)
    if (!events.length) {
      skipped++
      continue
    }
    for (const e of events) {
      console.log(`📅 ${e.city} ${e.startsAt.toISOString().slice(0, 16)} — ${e.title}`)
      if (!dry) {
        const created = await saveAnnouncement(e, m.id)
        if (created) ok++
      } else ok++
    }
    continue
  }

  const offer = await parseOffer(text)
  if (!offer) {
    skipped++
    continue
  }
  const photo = dry ? null : await importPhoto(m)
  const label = { give: '🎁 Отдам', sell: '💰 Продам', search: '🔎 Ищу' }[offer.kind]
  console.log(
    `${label} ${offer.title} — ${offer.price ?? 'цена не указана'} · ${offer.city}` +
      `${offer.district ? '/' + offer.district : ''} · ${who}${photo ? ' · с фото' : ''}`,
  )

  if (!dry) {
    // автор из выгрузки приходит строкой «user123456789»
    const authorTg = BigInt((m.from_id ?? '').replace(/\D/g, '') || '0')
    if (!authorTg) {
      skipped++
      continue
    }
    const saved = await saveOffer(offer, {
      id: m.id,
      authorTg,
      authorUsername: null,
      firstName: m.from ?? null,
      photo,
    })
    if (saved) ok++
  } else ok++
}

console.log(`\nготово: ${dry ? 'разобралось' : 'создано'} ${ok}, пропущено ${skipped}`)
await prisma.$disconnect()
