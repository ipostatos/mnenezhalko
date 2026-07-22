import { Bot, InlineKeyboard, Keyboard } from 'grammy'
import { env, isAdmin } from './env.js'
import { prisma } from './db.js'
import { searchBooks, type BookCard } from './search.js'
import { askAi } from './ai.js'
import { syncFromNotion } from './sync.js'
import { CITIES } from './seed.js'
import { saveCoverFromTelegram } from './covers.js'
import { recognizeCover, visionEnabled, type Recognized } from './vision.js'
import {
  findDuplicates,
  flushPending,
  pendingCount,
  putOnShelf,
  setPendingNotifier,
} from './publish.js'
import { notionWriteEnabled, whoAmI } from './notion-write.js'

export const bot = new Bot(env.botToken)

// ошибка в одном апдейте не должна ронять процесс
bot.catch((err) => {
  console.error('[bot] ошибка обработчика:', err.error)
})

const webAppUrl = () => env.publicUrl || ''

const mainKeyboard = () => {
  const kb = new InlineKeyboard()
  if (webAppUrl()) kb.webApp('📚 Открыть библиотеку', webAppUrl()).row()
  kb.url('💬 Чат проекта', env.mainChatUrl)
  return kb
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Карточка книги для чата: название, автор, город и контакт владельца. */
function bookLine(b: BookCard & { why?: string }): string {
  const parts = [`<b>${esc(b.title)}</b>`]
  if (b.author) parts.push(esc(b.author))
  const meta: string[] = []
  if (b.genres.length) meta.push(b.genres.slice(0, 3).join(', '))
  if (b.city) meta.push(b.district ? `${b.city} / ${b.district}` : b.city)
  if (meta.length) parts.push(`<i>${esc(meta.join(' · '))}</i>`)
  if (b.owner) {
    const contact = b.owner.telegram
      ? `<a href="https://t.me/${b.owner.telegram}">@${esc(b.owner.telegram)}</a>`
      : 'контакт уточняйте в чате'
    parts.push(`У кого: ${esc(b.owner.name)} — ${contact}`)
  }
  if (b.why) parts.push(`✨ ${esc(b.why)}`)
  return parts.join('\n')
}

const renderList = (items: (BookCard & { why?: string })[]) =>
  items.map(bookLine).join('\n\n')

bot.command('start', async (ctx) => {
  const total = await prisma.book.count({ where: { active: true, kind: 'book' } })
  await ctx.reply(
    [
      '👋 Привет! Это бот книжного проекта <b>«МнеНеЖалко»</b> в Польше.',
      '',
      `В библиотеке сейчас <b>${total}</b> книг у соседей по городам.`,
      '',
      'Что умею:',
      '📚 Быстрый доступ к библиотеке и поиск',
      '🤖 Подобрать книгу по настроению — просто напишите, чего хочется',
      '🏙 Городские чаты и ближайшие встречи',
      '🛍 Барахолка по городам — /baraholka',
      '📸 Сфотографируйте книгу — сам заполню карточку и поставлю её на полку',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: mainKeyboard(), link_preview_options: { is_disabled: true } },
  )
})

bot.command('help', (ctx) =>
  ctx.reply(
    [
      '<b>Команды</b>',
      '/find <i>запрос</i> — поиск по названию или автору',
      '/ai <i>что хочется почитать</i> — подбор книги ИИ-помощником',
      '/city — выбрать свой город',
      '/groups — чаты по городам',
      '/events — ближайшие встречи',
      '/baraholka — барахолка города',
      '',
      'Пришлите <b>фото книги или настолки</b> — распознаю название, автора, язык и жанр,',
      'заведу вас библиотекарем и добавлю книгу в общую таблицу проекта.',
      '',
      'Можно просто написать сообщение — я пойму это как запрос к помощнику.',
    ].join('\n'),
    { parse_mode: 'HTML' },
  ),
)

bot.command('find', async (ctx) => {
  const q = ctx.match?.toString().trim()
  if (!q) return ctx.reply('Напишите так: /find Брэдбери')
  const user = await prisma.user.findUnique({ where: { tgId: BigInt(ctx.from!.id) } })
  const { items, total } = await searchBooks({ q, city: user?.city ?? undefined, limit: 5 })
  if (!items.length) return ctx.reply('Ничего не нашлось. Попробуйте другое слово.')
  await ctx.reply(`Нашлось ${total}, показываю первые ${items.length}:\n\n${renderList(items)}`, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: mainKeyboard(),
  })
})

async function handleAi(ctx: any, text: string) {
  const user = await prisma.user.findUnique({ where: { tgId: BigInt(ctx.from.id) } })
  await ctx.replyWithChatAction('typing')
  const res = await askAi(text, user?.city ?? undefined)
  if (!res.items.length) {
    return ctx.reply('Пока ничего похожего не нашлось. Попробуйте описать иначе.')
  }
  await ctx.reply(`${res.intro}\n\n${renderList(res.items.slice(0, 5))}`, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: mainKeyboard(),
  })
}

bot.command('ai', async (ctx) => {
  const q = ctx.match?.toString().trim()
  if (!q) return ctx.reply('Напишите, чего хочется: /ai хочу про космос и одиночество')
  await handleAi(ctx, q)
})

bot.command('city', async (ctx) => {
  const kb = new InlineKeyboard()
  CITIES.forEach((c, i) => {
    kb.text(c, `city:${c}`)
    if (i % 2 === 1) kb.row()
  })
  kb.row().text('Все города', 'city:*')
  await ctx.reply('Выберите город — буду показывать книги и встречи рядом:', { reply_markup: kb })
})

bot.callbackQuery(/^city:(.+)$/, async (ctx) => {
  const city = ctx.match![1]
  const value = city === '*' ? null : city
  await prisma.user.upsert({
    where: { tgId: BigInt(ctx.from.id) },
    create: {
      tgId: BigInt(ctx.from.id),
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      city: value,
      isAdmin: isAdmin(ctx.from.id),
    },
    update: { city: value },
  })
  await ctx.answerCallbackQuery({ text: value ? `Город: ${value}` : 'Показываю все города' })
  await ctx.editMessageText(value ? `✅ Ваш город: ${value}` : '✅ Показываю книги по всем городам')
})

bot.command('groups', async (ctx) => {
  const user = await prisma.user.findUnique({ where: { tgId: BigInt(ctx.from!.id) } })
  const groups = await prisma.cityGroup.findMany({
    where: user?.city ? { OR: [{ city: user.city }, { city: 'Все города' }] } : {},
    orderBy: [{ sort: 'asc' }, { city: 'asc' }],
  })
  if (!groups.length) return ctx.reply('Ссылки на чаты пока не добавлены.')
  const kb = new InlineKeyboard()
  groups.forEach((g) => kb.url(`${g.city} — ${g.title}`, g.url).row())
  await ctx.reply('Чаты проекта:', { reply_markup: kb })
})

bot.command('events', async (ctx) => {
  const user = await prisma.user.findUnique({ where: { tgId: BigInt(ctx.from!.id) } })
  const events = await prisma.event.findMany({
    where: {
      startsAt: { gte: new Date(Date.now() - 6 * 3600_000) },
      ...(user?.city ? { city: user.city } : {}),
    },
    orderBy: { startsAt: 'asc' },
    take: 5,
  })
  if (!events.length) {
    return ctx.reply(
      'Ближайших встреч пока нет. Анонсы появляются в чате проекта.',
      { reply_markup: mainKeyboard() },
    )
  }
  const fmt = new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Warsaw',
  })
  const text = events
    .map((e) =>
      [
        `<b>${esc(e.title)}</b>`,
        `📅 ${fmt.format(e.startsAt)}`,
        `📍 ${esc(e.city)}${e.place ? ', ' + esc(e.place) : ''}`,
        e.description ? esc(e.description) : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n')
  await ctx.reply(text, { parse_mode: 'HTML' })
})

/* ── барахолка: короткий мастер прямо в чате ──────────────── */

type Draft = {
  step: 'city' | 'kind' | 'title' | 'description' | 'photo'
  city?: string
  kind?: string
  title?: string
  description?: string
}
const drafts = new Map<number, Draft>()

bot.command('baraholka', async (ctx) => {
  const items = await prisma.marketItem.findMany({
    where: { status: 'active' },
    orderBy: { bumpedAt: 'desc' },
    take: 5,
  })
  const kb = new InlineKeyboard().text('➕ Разместить объявление', 'market:new')
  if (!items.length) {
    return ctx.reply('Барахолка пока пуста — будьте первым!', { reply_markup: kb })
  }
  const labels: Record<string, string> = { give: '🎁 Отдам', sell: '💰 Продам', search: '🔎 Ищу' }
  const text = items
    .map((i) =>
      [
        `${labels[i.kind] ?? ''} <b>${esc(i.title)}</b>`,
        i.price ? `Цена: ${esc(i.price)}` : '',
        `📍 ${esc(i.city)}`,
        i.description ? esc(i.description) : '',
        i.authorUsername ? `Написать: @${esc(i.authorUsername)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n')
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb })
})

bot.callbackQuery('market:new', async (ctx) => {
  drafts.set(ctx.from.id, { step: 'city' })
  const kb = new InlineKeyboard()
  CITIES.forEach((c, i) => {
    kb.text(c, `mcity:${c}`)
    if (i % 2 === 1) kb.row()
  })
  await ctx.answerCallbackQuery()
  await ctx.reply('Город объявления:', { reply_markup: kb })
})

bot.callbackQuery(/^mcity:(.+)$/, async (ctx) => {
  const d = drafts.get(ctx.from.id)
  if (!d) return ctx.answerCallbackQuery({ text: 'Начните заново: /baraholka' })
  d.city = ctx.match![1]
  d.step = 'kind'
  await ctx.answerCallbackQuery()
  await ctx.reply('Что за объявление?', {
    reply_markup: new InlineKeyboard()
      .text('🎁 Отдам', 'mkind:give')
      .text('💰 Продам', 'mkind:sell')
      .text('🔎 Ищу', 'mkind:search'),
  })
})

bot.callbackQuery(/^mkind:(.+)$/, async (ctx) => {
  const d = drafts.get(ctx.from.id)
  if (!d) return ctx.answerCallbackQuery({ text: 'Начните заново: /baraholka' })
  d.kind = ctx.match![1]
  d.step = 'title'
  await ctx.answerCallbackQuery()
  await ctx.reply('Напишите заголовок одной строкой (например: «Отдам две коробки книг»).')
})

bot.command('cancel', async (ctx) => {
  drafts.delete(ctx.from!.id)
  await ctx.reply('Отменил.', { reply_markup: { remove_keyboard: true } })
})

/* ── фото книги → полка ───────────────────────────────────── */

type ShelfDraft = Recognized & { coverUrl: string }
const shelfDrafts = new Map<number, ShelfDraft>()

const shelfCard = (d: ShelfDraft) => {
  const lines = [`<b>${esc(d.title)}</b>`]
  if (d.author) lines.push(esc(d.author))
  const meta = [d.genres.join(', '), d.languages.join(', ')].filter(Boolean).join(' · ')
  if (meta) lines.push(`<i>${esc(meta)}</i>`)
  if (d.kind === 'game') lines.push('<i>Настольная игра</i>')
  if (d.confidence !== 'high') lines.push('⚠️ Проверьте название — фото читается не идеально.')
  if (d.note) lines.push(esc(d.note))
  return lines.join('\n')
}

const shelfKeyboard = () => {
  const kb = new InlineKeyboard().text('✅ Поставить на полку', 'shelf:save').row()
  if (webAppUrl()) kb.webApp('✏️ Уточнить в приложении', `${webAppUrl()}/?screen=add`)
  return kb
}

/** Фото книги в личке: распознаём и предлагаем поставить на полку. */
async function handleBookPhoto(ctx: any) {
  if (!visionEnabled()) {
    return ctx.reply(
      'Распознавание по фото сейчас недоступно. Добавьте книгу вручную в приложении.',
      { reply_markup: mainKeyboard() },
    )
  }
  const photo = ctx.message.photo.at(-1)!
  await ctx.replyWithChatAction('typing')

  const saved = await saveCoverFromTelegram(photo.file_id)
  if (!saved) return ctx.reply('Не смог скачать фото, пришлите ещё раз.')

  const recognized = await recognizeCover(saved.decoded.data, saved.decoded.mediaType).catch(
    (e: any) => {
      console.error('[vision] ошибка распознавания:', e?.message ?? e)
      return null
    },
  )
  if (!recognized || !recognized.recognized || !recognized.title) {
    return ctx.reply(
      recognized?.note
        ? `Не разобрал книгу: ${recognized.note}`
        : 'Не разобрал, что на фото. Переснимите так, чтобы читались название и автор.',
    )
  }

  shelfDrafts.set(ctx.from.id, { ...recognized, coverUrl: saved.url })

  const dups = await findDuplicates(recognized.title, recognized.author)
  const dupText = dups.length
    ? '\n\nКстати, такая книга уже есть:\n' +
      dups
        .map((b) => `• ${esc(b.title)}${b.owner ? ` — ${esc(b.owner.name)}` : ''}`)
        .join('\n')
    : ''

  await ctx.reply(`Похоже, это:\n\n${shelfCard(shelfDrafts.get(ctx.from.id)!)}${dupText}`, {
    parse_mode: 'HTML',
    reply_markup: shelfKeyboard(),
  })
}

bot.callbackQuery('shelf:save', async (ctx) => {
  const d = shelfDrafts.get(ctx.from.id)
  if (!d) return ctx.answerCallbackQuery({ text: 'Пришлите фото книги ещё раз' })

  const user = await prisma.user.findUnique({ where: { tgId: BigInt(ctx.from.id) } })
  if (!user?.city) {
    const kb = new InlineKeyboard()
    CITIES.forEach((c, i) => {
      kb.text(c, `shelfcity:${c}`)
      if (i % 2 === 1) kb.row()
    })
    await ctx.answerCallbackQuery()
    return ctx.reply('В каком городе стоит книга?', { reply_markup: kb })
  }

  await ctx.answerCallbackQuery({ text: 'Ставлю на полку…' })
  await saveShelfDraft(ctx, d, user.city)
})

bot.callbackQuery(/^shelfcity:(.+)$/, async (ctx) => {
  const d = shelfDrafts.get(ctx.from.id)
  if (!d) return ctx.answerCallbackQuery({ text: 'Пришлите фото книги ещё раз' })
  const city = ctx.match![1]
  await prisma.user.upsert({
    where: { tgId: BigInt(ctx.from.id) },
    create: {
      tgId: BigInt(ctx.from.id),
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      city,
      isAdmin: isAdmin(ctx.from.id),
    },
    update: { city },
  })
  await ctx.answerCallbackQuery({ text: 'Ставлю на полку…' })
  await saveShelfDraft(ctx, d, city)
})

async function saveShelfDraft(ctx: any, d: ShelfDraft, city: string) {
  shelfDrafts.delete(ctx.from.id)
  const res = await putOnShelf({
    tgId: BigInt(ctx.from.id),
    username: ctx.from.username ?? null,
    firstName: ctx.from.first_name ?? null,
    kind: d.kind,
    title: d.title,
    author: d.author,
    genres: d.genres,
    languages: d.languages,
    city,
    coverUrl: d.coverUrl,
  })

  const inNotion =
    res.notionStatus === 'synced'
      ? 'Книга уже в общей таблице проекта.'
      : 'Книга видна в боте и поиске; в общую таблицу проекта уйдёт чуть позже.'

  await ctx.reply(`🎉 Готово! «${esc(res.book.title)}» на вашей полке.\n${inNotion}`, {
    parse_mode: 'HTML',
    reply_markup: mainKeyboard(),
  })
}

/* ── админские команды ────────────────────────────────────── */

bot.command('sync', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return
  await ctx.reply('Синхронизирую с Notion, это займёт минуту…')
  try {
    const r = await syncFromNotion()
    await ctx.reply(
      `Готово за ${(r.ms / 1000).toFixed(0)}с: книг ${r.books}, настолок ${r.games}, ` +
        `библиотекарей ${r.librarians}, скрыто ${r.deactivated}.`,
    )
  } catch (e: any) {
    await ctx.reply(`Ошибка синхронизации: ${e?.message ?? e}`)
  }
})

/** Состояние канала записи в общую таблицу Notion. */
bot.command('notion', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return
  const waiting = await pendingCount()
  if (!notionWriteEnabled()) {
    return ctx.reply(
      `Запись в Notion выключена — нет NOTION_TOKEN_V2.\nЖдут отправки карточек: ${waiting}.`,
    )
  }
  try {
    const me = await whoAmI()
    await ctx.reply(
      `Запись в Notion включена, аккаунт: ${me?.email ?? me?.id ?? 'неизвестен'}.\n` +
        `Ждут отправки карточек: ${waiting}.\nДожать: /notionpush`,
    )
  } catch (e: any) {
    await ctx.reply(`Токен Notion не работает: ${e?.message ?? e}\nЖдут отправки: ${waiting}.`)
  }
})

/** Дожать карточки, которые ещё не уехали в общую таблицу. */
bot.command('notionpush', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return
  if (!notionWriteEnabled()) return ctx.reply('Нет NOTION_TOKEN_V2 — отправлять нечем.')
  await ctx.reply('Отправляю…')
  const r = await flushPending()
  await ctx.reply(`Ушло в Notion: ${r.ok}, не получилось: ${r.failed}.`)
})

bot.command('addgroup', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return
  const parts = (ctx.match?.toString() || '').split('|').map((s) => s.trim())
  if (parts.length < 3) {
    return ctx.reply('Формат: /addgroup Город | Название | https://t.me/...')
  }
  const [city, title, url] = parts
  await prisma.cityGroup.create({ data: { city, title, url } })
  await ctx.reply(`Добавил чат «${title}» для города ${city}.`)
})

bot.command('addevent', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return
  const parts = (ctx.match?.toString() || '').split('|').map((s) => s.trim())
  if (parts.length < 3) {
    return ctx.reply('Формат: /addevent Город | 2026-08-01 18:30 | Название | Место')
  }
  const [city, when, title, place] = parts
  const startsAt = new Date(when.replace(' ', 'T') + ':00+02:00')
  if (Number.isNaN(startsAt.getTime())) return ctx.reply('Не понял дату. Формат: 2026-08-01 18:30')
  await prisma.event.create({
    data: { city, title, startsAt, place: place || null, createdBy: BigInt(ctx.from!.id) },
  })
  await ctx.reply(`Встреча «${title}» добавлена.`)
})

/* ── свободный текст: продолжение мастера либо запрос к ИИ ── */

bot.on('message:photo', async (ctx) => {
  const d = drafts.get(ctx.from.id)
  if (d?.step === 'photo') {
    const photo = ctx.message.photo.at(-1)!
    return saveDraft(ctx, d, photo.file_id)
  }
  // фото вне мастера барахолки считаем обложкой книги
  if (ctx.chat.type !== 'private') return
  await handleBookPhoto(ctx)
})

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim()
  if (text.startsWith('/')) return
  const d = drafts.get(ctx.from.id)

  if (d?.step === 'title') {
    d.title = text.slice(0, 200)
    d.step = 'description'
    return ctx.reply('Добавьте описание и цену (или напишите «-», чтобы пропустить).')
  }
  if (d?.step === 'description') {
    d.description = text === '-' ? undefined : text.slice(0, 1000)
    d.step = 'photo'
    return ctx.reply('Пришлите фото или напишите «-», чтобы опубликовать без фото.')
  }
  if (d?.step === 'photo') {
    return saveDraft(ctx, d, null)
  }

  if (ctx.chat.type !== 'private') return
  await handleAi(ctx, text.slice(0, 500))
})

async function saveDraft(ctx: any, d: Draft, photo: string | null) {
  drafts.delete(ctx.from.id)
  await prisma.user.upsert({
    where: { tgId: BigInt(ctx.from.id) },
    create: {
      tgId: BigInt(ctx.from.id),
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      isAdmin: isAdmin(ctx.from.id),
    },
    update: { username: ctx.from.username },
  })
  await prisma.marketItem.create({
    data: {
      city: d.city!,
      kind: d.kind ?? 'give',
      title: d.title!,
      description: d.description ?? null,
      photo,
      authorTg: BigInt(ctx.from.id),
      authorUsername: ctx.from.username ?? null,
    },
  })
  await ctx.reply('Опубликовал в барахолке 🎉 Посмотреть: /baraholka', {
    reply_markup: mainKeyboard(),
  })
}

/**
 * Карточки, не уехавшие в общую таблицу, показываем админам —
 * это ровно тот случай из инструкции, когда «админы внесут сами».
 */
setPendingNotifier(async (book, reason) => {
  if (!env.adminIds.length) return
  const text = [
    '📥 Новая книга ждёт общей таблицы',
    '',
    `<b>${esc(book.title)}</b>${book.author ? '\n' + esc(book.author) : ''}`,
    book.genres.length ? `<i>${esc(book.genres.join(', '))}</i>` : '',
    book.owner
      ? `Библиотекарь: ${esc(book.owner.name)}${book.owner.telegram ? ` (@${esc(book.owner.telegram)})` : ''}`
      : '',
    book.city ? `📍 ${esc(book.city)}${book.district ? ' / ' + esc(book.district) : ''}` : '',
    book.coverUrl ? `Обложка: ${esc(book.coverUrl)}` : '',
    '',
    `Причина: ${esc(reason)}`,
  ]
    .filter(Boolean)
    .join('\n')

  for (const id of env.adminIds) {
    await bot.api
      .sendMessage(String(id), text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      })
      .catch(() => {})
  }
})

export async function setupBotCommands() {
  await bot.api.setMyCommands([
    { command: 'start', description: 'Библиотека и меню' },
    { command: 'find', description: 'Поиск книги по названию или автору' },
    { command: 'ai', description: 'Подобрать книгу по настроению' },
    { command: 'city', description: 'Выбрать свой город' },
    { command: 'groups', description: 'Чаты по городам' },
    { command: 'events', description: 'Ближайшие встречи' },
    { command: 'baraholka', description: 'Барахолка по городам' },
    { command: 'help', description: 'Помощь' },
  ])
  // постоянная кнопка Mini App слева от поля ввода
  if (webAppUrl()) {
    await bot.api.setChatMenuButton({
      menu_button: { type: 'web_app', text: 'Библиотека', web_app: { url: webAppUrl() } },
    })
  }
}
