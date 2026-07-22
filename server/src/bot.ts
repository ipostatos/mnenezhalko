import { Bot, InlineKeyboard, Keyboard } from 'grammy'
import { env, isAdmin } from './env.js'
import { prisma } from './db.js'
import { searchBooks, type BookCard } from './search.js'
import { askAi } from './ai.js'
import { syncFromNotion } from './sync.js'
import {
  CITIES,
  EVENTS_TOPIC_ID,
  INSTAGRAM_URL,
  MAIN_CHAT_ID,
  MARKET_TOPIC_ID,
  eventsTopicUrl,
  marketTopicUrl,
} from './seed.js'
import { parseOffer, saveOffer } from './market.js'
import {
  claimLoans,
  createLoan,
  daysOut,
  dueLoans,
  listBorrowed,
  listLoans,
  loanById,
  markReminded,
  markReturned,
} from './loans.js'
import { digest, type DigestPeriod } from './digest.js'
import { parseAnnouncement, saveAnnouncement } from './announce.js'
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

/** Ник бота нужен для ссылок-приглашений; уточняем его при старте. */
let BOT_USERNAME = 'mnenezhalkobot'
export const botUsername = () => BOT_USERNAME

const mainKeyboard = () => {
  const kb = new InlineKeyboard()
  if (webAppUrl()) kb.webApp('📚 Открыть библиотеку', webAppUrl()).row()
  kb.url('💬 Чат проекта', env.mainChatUrl).row()
  kb.url('📸 Инстаграм', INSTAGRAM_URL)
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
  // человек пришёл по ссылке-приглашению из выдачи книги
  const payload = ctx.match?.toString().trim() ?? ''
  const loanId = payload.startsWith('loan_') ? payload.slice(5) : undefined

  await prisma.user.upsert({
    where: { tgId: BigInt(ctx.from!.id) },
    create: {
      tgId: BigInt(ctx.from!.id),
      username: ctx.from!.username,
      firstName: ctx.from!.first_name,
      isAdmin: isAdmin(ctx.from!.id),
    },
    update: { username: ctx.from!.username },
  })
  const claimed = await claimLoans(BigInt(ctx.from!.id), ctx.from!.username, loanId)

  if (loanId) {
    const loan = await loanById(loanId)
    if (loan && loan.status === 'active') {
      await ctx.reply(
        [
          `📗 У вас книга <b>${esc(loan.title)}</b>.`,
          loan.dueAt ? `Договорились вернуть к ${loanFmt.format(loan.dueAt)}.` : '',
          '',
          'Как дочитаете — нажмите кнопку, и я закрою запись у владельца.',
        ]
          .filter(Boolean)
          .join('\n'),
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('✅ Вернул(а) книгу', `loan:back:${loan.id}`),
        },
      )
    }
  } else if (claimed) {
    await ctx.reply(
      `📗 Кстати, за вами числится ${claimed === 1 ? 'книга' : `книг: ${claimed}`} из библиотеки проекта. Посмотреть — /loans`,
    )
  }

  const total = await prisma.book.count({ where: { active: true, kind: 'book' } })
  await ctx.reply(
    [
      '<b>Добро пожаловать в «МнеНеЖалко»!</b> 👋',
      '',
      'Мы создаем сообщество, где бумажные книги получают вторую жизнь, а люди – ' +
        'возможность читать, знакомиться и поддерживать друг друга, особенно в миграции 🐝',
      '',
      'Благодаря «МнеНеЖалко» можно найти книги на полках у других участников проекта, ' +
        'взять их почитать на время или обменяться навсегда. А наши встречи – это не только ' +
        'про обмен книгами, но и про душевное общение, обсуждение литературы и поиск новых друзей 🤗',
      '',
      `Сейчас на полках соседей <b>${total}</b> книг.`,
      '',
      'Что умею:',
      '📚 Библиотека проекта и поиск',
      '🤖 Подобрать книгу по настроению — просто напишите, чего хочется',
      '🆕 Новинки за сутки и месяц — /new',
      '📕 Помню, у кого ваша книга — /lend и /loans',
      '🏙 Городские чаты — /groups, встречи — /events',
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
      '/new — новинки библиотеки за сутки и за месяц',
      '/lend <i>Название | @ник</i> — отметить, кому отдали книгу',
      '/loans — у кого мои книги сейчас и что читаю я',
      '/city — выбрать свой город',
      '/groups — чаты по городам',
      '/events — ближайшие встречи',
      '/alerts — анонсы новых встреч: включить или выключить',
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

/* ── «у кого моя книга сейчас» ────────────────────────────── */

const loanFmt = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeZone: 'Europe/Warsaw' })

const loanLink = (id: string) => `https://t.me/${BOT_USERNAME}?start=loan_${id}`

/** Строка выдачи: книга, у кого, сколько дней, срок. */
function loanLine(l: {
  title: string
  holderUsername: string | null
  holderName: string | null
  takenAt: Date
  dueAt: Date | null
  status: string
}) {
  const who = l.holderUsername ? `@${l.holderUsername}` : (l.holderName ?? 'кто-то')
  const days = daysOut(l.takenAt)
  const overdue = l.dueAt && l.dueAt.getTime() < Date.now()
  const parts = [`📕 <b>${esc(l.title)}</b>`, `У кого: ${esc(who)} · ${days} дн.`]
  if (l.status === 'returned') parts.push('✅ вернулась')
  else if (l.dueAt) {
    parts.push(
      overdue
        ? `⏰ ждём с ${loanFmt.format(l.dueAt)}`
        : `Договорились до ${loanFmt.format(l.dueAt)}`,
    )
  }
  return parts.join('\n')
}

bot.command('loans', async (ctx) => {
  const tgId = BigInt(ctx.from!.id)
  const [given, taken] = await Promise.all([listLoans(tgId, 'active'), listBorrowed(tgId)])

  if (!given.length && !taken.length) {
    return ctx.reply(
      [
        'Пока никому ничего не отдавали — и вам не отдавали.',
        '',
        'Отдали книгу почитать? Отметьте, чтобы не забыть:',
        '<code>/lend Название книги | @ник</code>',
        '',
        'Через месяц напомню и вам, и читателю.',
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: mainKeyboard() },
    )
  }

  const kb = new InlineKeyboard()
  given.forEach((l) => kb.text(`✅ Вернулась: ${l.title.slice(0, 30)}`, `loan:back:${l.id}`).row())
  if (webAppUrl()) kb.webApp('📚 Открыть библиотеку', webAppUrl())

  const blocks: string[] = []
  if (given.length) {
    blocks.push(`<b>Мои книги на руках (${given.length})</b>\n\n${given.map(loanLine).join('\n\n')}`)
  }
  if (taken.length) {
    blocks.push(
      `<b>Я читаю сейчас (${taken.length})</b>\n\n` +
        taken.map((l) => `📗 <b>${esc(l.title)}</b> · ${daysOut(l.takenAt)} дн.`).join('\n'),
    )
  }

  await ctx.reply(blocks.join('\n\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  })
})

bot.command('lend', async (ctx) => {
  const raw = ctx.match?.toString().trim() ?? ''
  const [title, holder, when] = raw.split('|').map((s) => s.trim())
  if (!title || !holder) {
    return ctx.reply(
      [
        'Формат: <code>/lend Название книги | @ник</code>',
        'Можно добавить срок: <code>/lend Дюна | @anna | 14</code> — дней до возврата.',
      ].join('\n'),
      { parse_mode: 'HTML' },
    )
  }

  await prisma.user.upsert({
    where: { tgId: BigInt(ctx.from!.id) },
    create: {
      tgId: BigInt(ctx.from!.id),
      username: ctx.from!.username,
      firstName: ctx.from!.first_name,
      isAdmin: isAdmin(ctx.from!.id),
    },
    update: { username: ctx.from!.username },
  })

  // если книга есть на полке владельца — привяжем карточку
  const own = await prisma.librarian.findUnique({ where: { tgId: BigInt(ctx.from!.id) } })
  const book = own
    ? await prisma.book.findFirst({
        where: { ownerId: own.id, active: true, title: { contains: title } },
        select: { id: true },
      })
    : null

  try {
    const loan = await createLoan({
      ownerTg: BigInt(ctx.from!.id),
      title,
      bookId: book?.id ?? null,
      holder,
      days: when ? Number(when) || null : undefined,
    })
    await sendLoanCreated(ctx, loan)
  } catch (e: any) {
    const messages: Record<string, string> = {
      bad_holder: 'Не понял ник. Напишите его как @ник или ссылкой t.me/ник.',
      empty_title: 'Не понял название книги.',
    }
    await ctx.reply(messages[e?.message] ?? `Не получилось: ${e?.message ?? e}`)
  }
})

/** Сообщение владельцу после отметки + попытка предупредить читателя. */
async function sendLoanCreated(ctx: any, loan: any) {
  const due = loan.dueAt ? `\nЖдём обратно к ${loanFmt.format(loan.dueAt)}.` : ''
  const reached = await notifyHolder(loan)

  await ctx.reply(
    [
      `📕 Записал: «${esc(loan.title)}» у @${esc(loan.holderUsername)}.${due}`,
      '',
      reached
        ? 'Читателю написал — он сможет отметить возврат сам.'
        : 'Читатель ещё не знаком с ботом. Перешлите ему ссылку, чтобы он получал напоминания:',
      reached ? '' : loanLink(loan.id),
      '',
      'Все выдачи — /loans',
    ]
      .filter(Boolean)
      .join('\n'),
    {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard().text('✅ Уже вернулась', `loan:back:${loan.id}`),
    },
  )
}

/** Пишет читателю, если он знаком боту. Возвращает, дошло ли. */
async function notifyHolder(loan: any): Promise<boolean> {
  if (!loan.holderTg) return false
  const owner = await prisma.user.findUnique({ where: { tgId: loan.ownerTg } })
  const from = owner?.username ? `@${owner.username}` : (owner?.firstName ?? 'Владелец')
  const due = loan.dueAt ? `\nДоговорились до ${loanFmt.format(loan.dueAt)}.` : ''
  return bot.api
    .sendMessage(
      String(loan.holderTg),
      [
        `📗 ${esc(from)} отметил, что у вас его книга:`,
        `<b>${esc(loan.title)}</b>${due}`,
        '',
        'Как дочитаете — верните и нажмите кнопку, я закрою запись.',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('✅ Вернул(а) книгу', `loan:back:${loan.id}`),
      },
    )
    .then(() => true)
    .catch(() => false)
}

bot.callbackQuery(/^loan:back:(.+)$/, async (ctx) => {
  const loan = await markReturned(ctx.match![1], BigInt(ctx.from.id))
  if (!loan) return ctx.answerCallbackQuery({ text: 'Эта запись уже закрыта' })

  await ctx.answerCallbackQuery({ text: 'Книга дома 🎉' })
  await ctx.editMessageText(`✅ «${esc(loan.title)}» вернулась. Спасибо!`, { parse_mode: 'HTML' })

  // вторая сторона тоже должна узнать
  const other = ctx.from.id === Number(loan.ownerTg) ? loan.holderTg : loan.ownerTg
  if (other) {
    await bot.api
      .sendMessage(String(other), `✅ «${loan.title}» отмечена как вернувшаяся.`)
      .catch(() => {})
  }
})

/**
 * Раз в сутки напоминаем про просроченные книги — мягко, обеим сторонам,
 * и не чаще раза в неделю по одной выдаче.
 */
export async function remindOverdueLoans() {
  const loans = await dueLoans()
  for (const loan of loans) {
    const days = daysOut(loan.takenAt)
    const kb = new InlineKeyboard().text('✅ Книга вернулась', `loan:back:${loan.id}`)

    if (loan.holderTg) {
      await bot.api
        .sendMessage(
          String(loan.holderTg),
          `📗 Напоминание: книга «${loan.title}» у вас уже ${days} дн. ` +
            'Если дочитали — самое время вернуть её владельцу 🙂',
          { reply_markup: kb },
        )
        .catch(() => {})
    }
    await bot.api
      .sendMessage(
        String(loan.ownerTg),
        `📕 Ваша книга «${loan.title}» у @${loan.holderUsername ?? 'читателя'} уже ${days} дн.` +
          (loan.holderTg ? '\nЯ напомнил читателю.' : `\nЧитатель пока не в боте: ${loanLink(loan.id)}`),
        { reply_markup: kb, link_preview_options: { is_disabled: true } },
      )
      .catch(() => {})
    await markReminded(loan.id)
    await new Promise((r) => setTimeout(r, 50))
  }
  if (loans.length) console.log(`[loans] напомнил по ${loans.length} выдачам`)
}

/* ── дайджест новинок ─────────────────────────────────────── */

const periodLabel: Record<DigestPeriod, string> = { day: 'за сутки', month: 'за месяц' }

async function sendDigest(ctx: any, period: DigestPeriod, edit = false) {
  const user = await prisma.user.findUnique({ where: { tgId: BigInt(ctx.from.id) } })
  const d = await digest(period, user?.city ?? undefined, 10)

  const other: DigestPeriod = period === 'day' ? 'month' : 'day'
  const kb = new InlineKeyboard().text(`Показать ${periodLabel[other]}`, `digest:${other}`)
  if (webAppUrl()) kb.row().webApp('📚 Открыть библиотеку', webAppUrl())

  const where = user?.city ? ` в городе ${user.city}` : ''
  if (!d.total) {
    const text = `Новинок${where} ${periodLabel[period]} пока нет. Может, ваша книга станет первой?`
    return edit ? ctx.editMessageText(text, { reply_markup: kb }) : ctx.reply(text, { reply_markup: kb })
  }

  const cities = d.byCity
    .slice(0, 5)
    .map((c) => `${c.city} — ${c.count}`)
    .join(' · ')

  const text = [
    `🆕 <b>Новинки ${periodLabel[period]}${where}: ${d.total}</b>`,
    cities && !user?.city ? `<i>${esc(cities)}</i>` : '',
    '',
    renderList(d.items.slice(0, 5)),
    d.total > 5 ? `\n…и ещё ${d.total - 5}. Всё — в библиотеке.` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const options = {
    parse_mode: 'HTML' as const,
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  }
  return edit ? ctx.editMessageText(text, options) : ctx.reply(text, options)
}

bot.command('new', (ctx) => sendDigest(ctx, 'day'))
bot.command('digest', (ctx) => sendDigest(ctx, 'day'))

bot.callbackQuery(/^digest:(day|month)$/, async (ctx) => {
  await ctx.answerCallbackQuery()
  await sendDigest(ctx, ctx.match![1] as DigestPeriod, true)
})

/* ── анонсы встреч ────────────────────────────────────────── */

bot.command('alerts', async (ctx) => {
  const user = await prisma.user.upsert({
    where: { tgId: BigInt(ctx.from!.id) },
    create: {
      tgId: BigInt(ctx.from!.id),
      username: ctx.from!.username,
      firstName: ctx.from!.first_name,
      isAdmin: isAdmin(ctx.from!.id),
    },
    update: {},
  })
  const kb = new InlineKeyboard().text(
    user.eventAlerts ? '🔕 Выключить анонсы' : '🔔 Включить анонсы',
    `alerts:${user.eventAlerts ? 'off' : 'on'}`,
  )
  await ctx.reply(
    user.eventAlerts
      ? 'Присылаю анонсы новых встреч' +
          (user.city ? ` в городе ${user.city}.` : ' во всех городах — выберите свой: /city.')
      : 'Анонсы встреч выключены.',
    { reply_markup: kb },
  )
})

bot.callbackQuery(/^alerts:(on|off)$/, async (ctx) => {
  const on = ctx.match![1] === 'on'
  await prisma.user.update({
    where: { tgId: BigInt(ctx.from.id) },
    data: { eventAlerts: on },
  })
  await ctx.answerCallbackQuery({ text: on ? 'Включил' : 'Выключил' })
  await ctx.editMessageText(
    on ? '🔔 Буду присылать анонсы новых встреч.' : '🔕 Анонсы встреч выключены. Вернуть: /alerts',
  )
})

const eventFmt = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'Europe/Warsaw',
})

/** Рассылает анонс тем, кто ждёт встречи этого города. */
export async function notifyNewEvent(event: {
  id: string
  city: string
  title: string
  startsAt: Date
  place: string | null
  description: string | null
}) {
  const users = await prisma.user.findMany({
    where: { eventAlerts: true, OR: [{ city: event.city }, { city: null }] },
    select: { tgId: true },
  })
  if (!users.length) return

  const text = [
    '📅 <b>Новая встреча МнеНеЖалко</b>',
    '',
    `<b>${esc(event.title)}</b>`,
    `🗓 ${eventFmt.format(event.startsAt)}`,
    `📍 ${esc(event.city)}${event.place ? ', ' + esc(event.place) : ''}`,
    event.description ? esc(event.description) : '',
    '',
    '<i>Выключить анонсы — /alerts</i>',
  ]
    .filter(Boolean)
    .join('\n')

  const kb = new InlineKeyboard().url('💬 Афиша в чате проекта', eventsTopicUrl())

  let sent = 0
  for (const u of users) {
    const ok = await bot.api
      .sendMessage(String(u.tgId), text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: kb,
      })
      .then(() => true)
      .catch(() => false)
    if (ok) sent++
    // Telegram не любит больше ~30 сообщений в секунду
    await new Promise((r) => setTimeout(r, 40))
  }
  console.log(`[events] анонс «${event.title}» разослан: ${sent} из ${users.length}`)
}

/** Афиша из темы общего чата → встреча + алерт. */
async function handleAnnouncement(ctx: any, text: string) {
  const events = await parseAnnouncement(text).catch((e: any) => {
    console.error('[events] не разобрал афишу:', e?.message ?? e)
    return []
  })
  for (const e of events) {
    const created = await saveAnnouncement(e, ctx.message.message_id)
    if (created) await notifyNewEvent(created)
  }
}

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
  const afisha = new InlineKeyboard().url('💬 Афиша встреч в чате', eventsTopicUrl())
  if (!events.length) {
    return ctx.reply(
      'Ближайших встреч пока нет. Анонсы появляются в афише чата проекта — ' +
        'как только там будет новая встреча, я пришлю её вам (/alerts).',
      { reply_markup: afisha },
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
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: afisha })
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
  const kb = new InlineKeyboard()
    .text('➕ Разместить объявление', 'market:new')
    .row()
    .url('💬 Барахолка в чате', marketTopicUrl())
  if (!items.length) {
    return ctx.reply('Барахолка пока пуста — будьте первым!', { reply_markup: kb })
  }
  const text = items.map(marketCard).join('\n\n')
  await ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: kb,
  })
})

const MARKET_LABELS: Record<string, string> = {
  give: '🎁 Отдам',
  sell: '💰 Продам',
  search: '🔎 Ищу',
}

/** Ровная карточка объявления: тип, цена, город, кому написать. */
function marketCard(i: {
  kind: string
  title: string
  price: string | null
  city: string
  description: string | null
  authorUsername: string | null
  authorTg: bigint
}): string {
  const meta = [i.price, i.city !== 'Все города' ? i.city : null].filter(Boolean).join(' · ')
  const contact = i.authorUsername
    ? `<a href="https://t.me/${i.authorUsername}">@${esc(i.authorUsername)}</a>`
    : `<a href="tg://user?id=${i.authorTg}">написать автору</a>`
  return [
    `${MARKET_LABELS[i.kind] ?? '📦'} <b>${esc(i.title)}</b>`,
    meta ? `<i>${esc(meta)}</i>` : '',
    i.description ? esc(i.description) : '',
    `Написать: ${contact}`,
  ]
    .filter(Boolean)
    .join('\n')
}

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
  const event = await prisma.event.create({
    data: { city, title, startsAt, place: place || null, createdBy: BigInt(ctx.from!.id) },
  })
  await ctx.reply(`Встреча «${title}» добавлена, рассылаю анонс.`)
  await notifyNewEvent(event)
})

/* ── свободный текст: продолжение мастера либо запрос к ИИ ── */

bot.on('message:photo', async (ctx) => {
  const d = drafts.get(ctx.from.id)
  if (d?.step === 'photo') {
    const photo = ctx.message.photo.at(-1)!
    return saveDraft(ctx, d, photo.file_id)
  }
  // афиша и барахолка обычно приходят картинкой с подписью
  const caption = ctx.message.caption?.trim()
  if (isEventsTopic(ctx)) return caption ? handleAnnouncement(ctx, caption) : undefined
  if (isMarketTopic(ctx)) return caption ? handleMarketPost(ctx, caption) : undefined
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

  if (isEventsTopic(ctx)) return handleAnnouncement(ctx, text)
  if (isMarketTopic(ctx)) return handleMarketPost(ctx, text)
  if (ctx.chat.type !== 'private') return
  await handleAi(ctx, text.slice(0, 500))
})

/** Сообщение из темы «Афиша встреч» общего чата. */
const isEventsTopic = (ctx: any) =>
  BigInt(ctx.chat?.id ?? 0) === MAIN_CHAT_ID && ctx.message?.message_thread_id === EVENTS_TOPIC_ID

/** Сообщение из темы «Барахолка» общего чата. */
const isMarketTopic = (ctx: any) =>
  BigInt(ctx.chat?.id ?? 0) === MAIN_CHAT_ID && ctx.message?.message_thread_id === MARKET_TOPIC_ID

/** Пост барахолки из чата → карточка с фото, ценой, городом и контактом. */
async function handleMarketPost(ctx: any, text: string) {
  const offer = await parseOffer(text).catch((e: any) => {
    console.error('[market] не разобрал объявление:', e?.message ?? e)
    return null
  })
  if (!offer) return

  const photo = ctx.message.photo?.at(-1)?.file_id ?? null
  const saved = await saveOffer(offer, {
    id: ctx.message.message_id,
    authorTg: BigInt(ctx.from.id),
    authorUsername: ctx.from.username ?? null,
    firstName: ctx.from.first_name ?? null,
    photo,
  })
  if (saved) {
    console.log(`[market] объявление из чата: «${saved.title}» (${saved.city})`)
  }
}

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
  const me = await bot.api.getMe().catch(() => null)
  if (me?.username) BOT_USERNAME = me.username

  await bot.api.setMyCommands([
    { command: 'start', description: 'Библиотека и меню' },
    { command: 'find', description: 'Поиск книги по названию или автору' },
    { command: 'ai', description: 'Подобрать книгу по настроению' },
    { command: 'new', description: 'Новинки библиотеки за сутки и месяц' },
    { command: 'loans', description: 'У кого моя книга сейчас' },
    { command: 'city', description: 'Выбрать свой город' },
    { command: 'groups', description: 'Чаты по городам' },
    { command: 'events', description: 'Ближайшие встречи' },
    { command: 'alerts', description: 'Анонсы новых встреч' },
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
