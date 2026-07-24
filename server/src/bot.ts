import { Bot, InlineKeyboard, Keyboard } from 'grammy'
import { env, isAdmin } from './env.js'
import { prisma } from './db.js'
import { searchBooks, toCard, type BookCard } from './search.js'
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
  loanMood,
  markReminded,
  markReturned,
  summarize,
} from './loans.js'
import { digest, type DigestPeriod } from './digest.js'
import { parseAnnouncement, saveAnnouncement } from './announce.js'
import { saveCoverFromTelegram } from './covers.js'
import { recognizeCover, visionEnabled, type Recognized } from './vision.js'
import {
  approveBook,
  findDuplicates,
  flushPending,
  moderationQueueCount,
  pendingCount,
  putOnShelf,
  rejectBook,
  setModerationNotifier,
  setPendingNotifier,
} from './publish.js'
import { notionWriteEnabled, whoAmI } from './notion-write.js'
import {
  linkLibrarian,
  setMergeNotifier,
  setTelegramFailNotifier,
  flushTelegramUpdates,
  pendingTelegramCount,
} from './librarian.js'

// при DISABLE_BOT=1 токена может не быть вовсе, но модуль всё равно импортируется
// (из routes.ts за ником бота) — grammY на пустой строке падает, отсюда заглушка
export const bot = new Bot(env.botToken || '0:disabled')

// ошибка в одном апдейте не должна ронять процесс
bot.catch((err) => {
  console.error('[bot] ошибка обработчика:', err.error)
})

/**
 * Один апдейт — один ответ.
 * Telegram повторяет доставку, если вебхук ответил не 200 (а он отвечал 500
 * по таймауту на долгих ИИ-ответах) — и бот отвечал заново на то же сообщение.
 * Держим id обработанных апдейтов 15 минут: этого хватает на всю цепочку повторов.
 */
const SEEN_TTL_MS = 15 * 60_000
const seenUpdates = new Map<number, number>()

bot.use(async (ctx, next) => {
  const id = ctx.update.update_id
  const now = Date.now()
  for (const [seen, at] of seenUpdates) if (now - at > SEEN_TTL_MS) seenUpdates.delete(seen)
  if (seenUpdates.has(id)) {
    console.warn(`[bot] повторная доставка апдейта ${id} — пропускаю`)
    return
  }
  seenUpdates.set(id, now)
  await next()
})

const webAppUrl = () => env.publicUrl || ''

/** Ник бота нужен для ссылок-приглашений; уточняем его при старте. */
let BOT_USERNAME = 'mnenezhalkobot'
export const botUsername = () => BOT_USERNAME

const mainKeyboard = () => {
  const kb = new InlineKeyboard()
  if (webAppUrl()) {
    kb.webApp('📚 Открыть библиотеку', webAppUrl()).row()
    kb.webApp('🌿 О проекте', `${webAppUrl()}/?screen=about`).row()
  }
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

  // пришёл по кнопке «поддержать» из Mini App вне Telegram — сразу меню сумм
  if (payload === 'donate') return showDonateMenu(ctx)

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

  const total = await prisma.book.count({ where: { active: true, kind: 'book', reviewStatus: 'approved' } })
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
      `Сейчас на полках соседей <b>${total}</b> книг — открывайте библиотеку и выбирайте 👇`,
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
      '/donate — поддержать проект звёздами Telegram',
      '',
      'Пришлите <b>фото книги или настолки</b> — распознаю название, автора, язык и жанр,',
      'заведу вас библиотекарем и добавлю книгу в общую таблицу проекта.',
      '',
      'Можно просто написать сообщение — я пойму это как запрос к помощнику.',
    ].join('\n'),
    { parse_mode: 'HTML' },
  ),
)

/* ── донат Telegram Stars ─────────────────────────────────── */

/**
 * Разрешённые суммы доната в звёздах (XTR). Whitelist: и в боте, и в /api/donate/link
 * счёт выставляется только на эти суммы, произвольную через API не подсунуть.
 * Держать синхронно с DONATE_AMOUNTS в web/src/screens/About.tsx.
 */
export const DONATE_AMOUNTS = [50, 150, 500] as const
export type DonateAmount = (typeof DONATE_AMOUNTS)[number]
export const isDonateAmount = (n: unknown): n is DonateAmount =>
  typeof n === 'number' && (DONATE_AMOUNTS as readonly number[]).includes(n)

const DONATE_TITLE = 'Поддержать «МнеНеЖалко»'
const DONATE_DESC =
  'Спасибо! Взнос идёт на домен, сервер и ИИ-подбор книг — то, на чём живёт библиотека проекта.'

/**
 * Ссылка на счёт Telegram Stars для openInvoice в Mini App.
 * Зовём сырой метод: provider_token для XTR не нужен, а сигнатура Bot API
 * стабильна между версиями grammY (позиционная обёртка временами меняется).
 */
export function createDonateLink(amount: DonateAmount): Promise<string> {
  return bot.api.raw.createInvoiceLink({
    title: DONATE_TITLE,
    description: DONATE_DESC,
    payload: `donate:${amount}`,
    provider_token: '', // для Stars (XTR) не нужен; пустая строка — так документирует Telegram
    currency: 'XTR',
    prices: [{ label: `${amount} ⭐`, amount }],
  })
}

const donateKeyboard = () => {
  const kb = new InlineKeyboard()
  DONATE_AMOUNTS.forEach((a) => kb.text(`${a} ⭐`, `donate:${a}`))
  return kb
}

/** Меню сумм — для команды /donate и диплинка ?start=donate внутри чата бота. */
async function showDonateMenu(ctx: any) {
  await ctx.reply(
    [
      '⭐ <b>Поддержать «МнеНеЖалко»</b>',
      '',
      'Проект некоммерческий и держится на энтузиазме. Звёзды идут на домен, сервер',
      'и ИИ-подбор книг — то, без чего библиотека не живёт. Совсем не обязательно 🌿',
      '',
      'Выберите сумму — счёт откроется прямо здесь:',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: donateKeyboard() },
  )
}

bot.command('donate', showDonateMenu)

bot.callbackQuery(/^donate:(\d+)$/, async (ctx) => {
  const amount = Number(ctx.match![1])
  if (!isDonateAmount(amount)) return ctx.answerCallbackQuery({ text: 'Такой суммы нет' })
  await ctx.answerCallbackQuery()
  await ctx.api.raw.sendInvoice({
    chat_id: ctx.chat!.id,
    title: DONATE_TITLE,
    description: DONATE_DESC,
    payload: `donate:${amount}`,
    provider_token: '', // Stars (XTR): провайдер не нужен
    currency: 'XTR',
    prices: [{ label: `${amount} ⭐`, amount }],
  })
})

// перед списанием Telegram спрашивает подтверждение — соглашаемся (нет склада/доставки)
bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true).catch(() => {}))

// оплата прошла (в т.ч. из openInvoice в Mini App) — благодарим
bot.on('message:successful_payment', async (ctx) => {
  const stars = ctx.message.successful_payment.total_amount
  await ctx.reply(
    `🌿 Спасибо за поддержку — ${stars} ⭐! Благодаря вам библиотека проекта живёт и растёт.`,
    { reply_markup: mainKeyboard() },
  )
})

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

/**
 * Кто сейчас ждёт ответ помощника: пока думаем над одним запросом, второй
 * не запускаем — иначе человек получает пачку подборок вместо одной.
 * Значение — предупредили ли уже «секунду», чтобы не сыпать и этим.
 */
const aiBusy = new Map<number, { warned: boolean }>()

async function handleAi(ctx: any, text: string) {
  const tgId = ctx.from.id as number
  const busy = aiBusy.get(tgId)
  if (busy) {
    if (busy.warned) return
    busy.warned = true
    return ctx.reply('Секунду, уже подбираю книги 🙂')
  }
  aiBusy.set(tgId, { warned: false })
  try {
    const user = await prisma.user.findUnique({ where: { tgId: BigInt(tgId) } })
    await ctx.replyWithChatAction('typing')
    const res = await askAi(text, user?.city ?? undefined)
    if (!res.items.length) {
      return await ctx.reply('Пока ничего похожего не нашлось. Попробуйте описать иначе.')
    }
    await ctx.reply(`${res.intro}\n\n${renderList(res.items.slice(0, 5))}`, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: mainKeyboard(),
    })
  } finally {
    aiBusy.delete(tgId)
  }
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

/** Строка выдачи: настроение, книга, у кого, сколько дней, срок. */
function loanLine(l: {
  title: string
  holderUsername: string | null
  holderName: string | null
  takenAt: Date
  dueAt: Date | null
  status: string
}) {
  const who = l.holderUsername ? `@${l.holderUsername}` : (l.holderName ?? 'кто-то')
  const mood = loanMood(l.takenAt, l.dueAt)
  const parts = [
    `${mood.emoji} <b>${esc(l.title)}</b>`,
    `У кого: ${esc(who)} · ${mood.days} дн. · ${mood.label}`,
  ]
  if (l.status === 'returned') parts.push('✅ вернулась')
  else if (l.dueAt) {
    parts.push(
      mood.overdueDays > 0
        ? `⏰ ждём с ${loanFmt.format(l.dueAt)} (${mood.overdueDays} дн.)`
        : `Договорились до ${loanFmt.format(l.dueAt)}`,
    )
  }
  return parts.join('\n')
}

/** Шапка списка: сколько книг гуляет и как давно самая забытая. */
function loanDashboard(loans: { title: string; takenAt: Date; dueAt: Date | null }[]) {
  const s = summarize(loans)
  if (!s.active || !s.mood) return ''
  const lines = [
    `${s.mood.emoji} <b>Книг на руках: ${s.active}</b>`,
    `Дольше всех — «${esc(s.longestTitle ?? '')}», ${s.longestDays} дн. (${s.mood.label})`,
  ]
  if (s.overdue) lines.push(`⏰ Просрочено по договорённости: ${s.overdue}`)
  return lines.join('\n')
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
    blocks.push(loanDashboard(given))
    blocks.push(given.map(loanLine).join('\n\n'))
  }
  if (taken.length) {
    blocks.push(
      `<b>Я читаю сейчас (${taken.length})</b>\n\n` +
        taken
          .map((l) => {
            const m = loanMood(l.takenAt, l.dueAt)
            return `${m.emoji} <b>${esc(l.title)}</b> · ${m.days} дн. у меня`
          })
          .join('\n'),
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
  const [title, holder, ...rest] = raw.split('|').map((s) => s.trim())
  if (!title || !holder) {
    return ctx.reply(
      [
        'Формат: <code>/lend Название книги | @ник</code>',
        'Срок в днях: <code>/lend Дюна | @anna | 14</code>',
        'И дата выдачи, если отдали давно: <code>/lend Дюна | @anna | 14 | 2026-06-01</code>',
      ].join('\n'),
      { parse_mode: 'HTML' },
    )
  }

  // хвост команды: число — срок, дата — когда отдали, в любом порядке
  const when = rest.find((r) => /^\d+$/.test(r))
  const takenAt = rest.find((r) => /^\d{4}-\d{2}-\d{2}$/.test(r))

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
  const own = await linkLibrarian(
    { tgId: BigInt(ctx.from!.id), username: ctx.from!.username, firstName: ctx.from!.first_name },
    { allowCreate: false },
  )
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
      takenAt: takenAt ?? null,
    })
    await sendLoanCreated(ctx, loan)
  } catch (e: any) {
    const messages: Record<string, string> = {
      bad_holder: 'Не понял ник. Напишите его как @ник или ссылкой t.me/ник.',
      empty_title: 'Не понял название книги.',
      bad_date: 'Не понял дату. Формат: 2026-06-01.',
      future_date: 'Дата выдачи в будущем — проверьте, пожалуйста.',
      too_old_date: 'Слишком давняя дата, такое я уже не осилю.',
    }
    await ctx.reply(messages[e?.message] ?? `Не получилось: ${e?.message ?? e}`)
  }
})

/** Сообщение владельцу после отметки + попытка предупредить читателя. */
async function sendLoanCreated(ctx: any, loan: any) {
  const mood = loanMood(loan.takenAt, loan.dueAt)
  const since = mood.days > 0 ? ` Отдали ${loanFmt.format(loan.takenAt)} — это ${mood.days} дн. назад.` : ''
  const due = (loan.dueAt ? `\nЖдём обратно к ${loanFmt.format(loan.dueAt)}.` : '') + since
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
async function notifyNewEvent(event: {
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

/* ── барахолка: витрина темы «Барахолка» из чата проекта ─── */

bot.command('baraholka', async (ctx) => {
  const items = await prisma.marketItem.findMany({
    where: { status: 'active' },
    orderBy: { bumpedAt: 'desc' },
    take: 5,
  })
  const kb = new InlineKeyboard().url('💬 Открыть барахолку в чате', marketTopicUrl())
  if (!items.length) {
    return ctx.reply(
      'Пока пусто. Объявления сюда попадают из темы «Барахолка» в чате проекта — ' +
        'разместите своё там, и оно появится здесь.',
      { reply_markup: kb },
    )
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

  if (res.book.reviewStatus === 'pending') {
    return ctx.reply(
      `📖 «${esc(res.book.title)}» отправил на проверку модератору. ` +
        'Как одобрят — книга появится в библиотеке, и я вам сообщу.',
      { parse_mode: 'HTML', reply_markup: mainKeyboard() },
    )
  }

  const inNotion =
    res.notionStatus === 'synced'
      ? 'Книга уже в общей таблице проекта.'
      : 'Книга видна в боте и поиске; в общую таблицу проекта уйдёт чуть позже.'

  await ctx.reply(`🎉 Готово! «${esc(res.book.title)}» на вашей полке.\n${inNotion}`, {
    parse_mode: 'HTML',
    reply_markup: mainKeyboard(),
  })
}

/* ── модерация книг ───────────────────────────────────────── */

/** Карточка на модерацию с кнопками — для уведомления и для /queue. */
function moderationCard(b: BookCard, owner: { name: string; telegram: string | null } | null) {
  const lines = ['🔍 <b>Книга на проверку</b>', '', `<b>${esc(b.title)}</b>`]
  if (b.author) lines.push(esc(b.author))
  const meta = [b.genres.join(', '), b.languages.join(', ')].filter(Boolean).join(' · ')
  if (meta) lines.push(`<i>${esc(meta)}</i>`)
  if (b.kind === 'game') lines.push('<i>Настольная игра</i>')
  if (b.city) lines.push(`📍 ${esc(b.city)}${b.district ? ' / ' + esc(b.district) : ''}`)
  if (owner) {
    lines.push(
      `Библиотекарь: ${esc(owner.name)}${owner.telegram ? ` (@${esc(owner.telegram)})` : ''}`,
    )
  }
  const kb = new InlineKeyboard()
    .text('✅ Одобрить', `mod:ok:${b.id}`)
    .text('❌ Отклонить', `mod:no:${b.id}`)
    .row()
    .text('🔍 Дубли', `mod:dups:${b.id}`)
  return { text: lines.join('\n'), kb }
}

// новая книга ушла на модерацию — показываем админам карточку с кнопками
setModerationNotifier(async (book, owner) => {
  if (!env.adminIds.length) return
  const { text, kb } = moderationCard(book, owner)
  for (const id of env.adminIds) {
    await bot.api
      .sendMessage(String(id), text, {
        parse_mode: 'HTML',
        reply_markup: kb,
        link_preview_options: { is_disabled: true },
      })
      .catch(() => {})
  }
})

bot.callbackQuery(/^mod:ok:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Только для админов' })
  const res = await approveBook(ctx.match![1], BigInt(ctx.from.id))
  if (!res) return ctx.answerCallbackQuery({ text: 'Книга не найдена' })
  await ctx.answerCallbackQuery({ text: 'Одобрено ✅' })
  await ctx.editMessageText(`✅ Одобрено: «${esc(res.card.title)}» — теперь в каталоге.`, {
    parse_mode: 'HTML',
  })
  if (res.addedByTg) {
    await bot.api
      .sendMessage(
        String(res.addedByTg),
        `✅ Ваша книга «${esc(res.card.title)}» прошла проверку и появилась в библиотеке. Спасибо!`,
        { parse_mode: 'HTML', reply_markup: mainKeyboard() },
      )
      .catch(() => {})
  }
})

bot.callbackQuery(/^mod:no:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Только для админов' })
  const res = await rejectBook(ctx.match![1], BigInt(ctx.from.id), null)
  if (!res) return ctx.answerCallbackQuery({ text: 'Книга не найдена' })
  await ctx.answerCallbackQuery({ text: 'Отклонено' })
  await ctx.editMessageText(`❌ Отклонено: «${esc(res.card.title)}».`, { parse_mode: 'HTML' })
  if (res.addedByTg) {
    await bot.api
      .sendMessage(
        String(res.addedByTg),
        `К сожалению, книга «${esc(res.card.title)}» не прошла проверку. ` +
          'Если это ошибка — напишите @LizavetaZh.',
        { parse_mode: 'HTML' },
      )
      .catch(() => {})
  }
})

bot.callbackQuery(/^mod:dups:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Только для админов' })
  const book = await prisma.book.findUnique({ where: { id: ctx.match![1] } })
  if (!book) return ctx.answerCallbackQuery({ text: 'Книга не найдена' })
  await ctx.answerCallbackQuery()
  const dups = await findDuplicates(book.title, book.author)
  const text = dups.length
    ? 'Возможные дубли в каталоге:\n' +
      dups.map((b) => `• ${esc(b.title)}${b.owner ? ` — ${esc(b.owner.name)}` : ''}`).join('\n')
    : 'Дублей в каталоге не нашёл.'
  await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
})

/** Очередь модерации: показать книги, ждущие проверки. */
bot.command('queue', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return
  const count = await moderationQueueCount()
  if (!count) return ctx.reply('Очередь модерации пуста.')
  const rows = await prisma.book.findMany({
    where: { reviewStatus: 'pending' },
    include: { owner: true },
    orderBy: { submittedAt: 'asc' },
    take: 10,
  })
  await ctx.reply(`На проверке: ${count}. Показываю ${rows.length}:`)
  for (const b of rows) {
    const { text, kb } = moderationCard(toCard({ ...b, owner: b.owner }), b.owner)
    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: kb,
      link_preview_options: { is_disabled: true },
    })
    await new Promise((r) => setTimeout(r, 40))
  }
})

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
  const [waiting, contacts] = await Promise.all([pendingCount(), pendingTelegramCount()])
  if (!notionWriteEnabled()) {
    return ctx.reply(
      `Запись в Notion выключена — нет NOTION_TOKEN_V2.\nЖдут отправки карточек: ${waiting}.`,
    )
  }
  try {
    const me = await whoAmI()
    await ctx.reply(
      `Запись в Notion включена, аккаунт: ${me?.email ?? me?.id ?? 'неизвестен'}.\n` +
        `Ждут отправки: карточек ${waiting}, контактов ${contacts}.\nДожать: /notionpush`,
    )
  } catch (e: any) {
    await ctx.reply(`Токен Notion не работает: ${e?.message ?? e}\nЖдут отправки: ${waiting}.`)
  }
})

/** Дожать карточки и контакты, которые ещё не уехали в общую таблицу. */
bot.command('notionpush', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return
  if (!notionWriteEnabled()) return ctx.reply('Нет NOTION_TOKEN_V2 — отправлять нечем.')
  await ctx.reply('Отправляю…')
  const [books, contacts] = await Promise.all([flushPending(), flushTelegramUpdates()])
  await ctx.reply(
    `Карточки: ушло ${books.ok}, не получилось ${books.failed}.\n` +
      `Контакты: ушло ${contacts.ok}, не получилось ${contacts.failed}.`,
  )
})

/**
 * Диагностика связи с чатом проекта: видит ли бот группу и её сообщения.
 * Без этого «барахолка пуста» выглядит как поломка, хотя данных просто нет.
 */
bot.command('topics', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return
  const lines: string[] = []

  const me = await bot.api.getMe().catch(() => null)
  const canReadAll = me?.can_read_all_group_messages ?? false

  try {
    const chat = await bot.api.getChat(String(MAIN_CHAT_ID))
    lines.push(`✅ Вижу чат: <b>${esc(chat.title ?? String(MAIN_CHAT_ID))}</b>`)
    const member = await bot.api.getChatMember(String(MAIN_CHAT_ID), me!.id).catch(() => null)
    lines.push(`Статус бота: ${member?.status ?? 'неизвестен'}`)
    if (member?.status === 'administrator' || canReadAll) {
      lines.push('✅ Сообщения тем вижу — афиши и барахолка будут собираться.')
    } else {
      lines.push(
        '⚠️ Сообщения НЕ вижу: включён privacy mode. Сделайте бота администратором ' +
          'чата либо выключите режим у @BotFather → /setprivacy → Disable.',
      )
    }
  } catch (e: any) {
    lines.push(
      `❌ Чат недоступен: ${esc(e?.description ?? e?.message ?? String(e))}`,
      'Добавьте @' + BOT_USERNAME + ' в чат проекта.',
    )
  }

  const [market, events] = await Promise.all([
    prisma.marketItem.count({ where: { source: 'topic' } }),
    prisma.event.count({ where: { source: 'topic' } }),
  ])
  lines.push(
    '',
    `Из тем собрано: объявлений ${market}, встреч ${events}.`,
    `Темы: барахолка ${MARKET_TOPIC_ID}, афиша ${EVENTS_TOPIC_ID}.`,
    'Историю бот не видит — прошлые посты переносятся импортом выгрузки.',
  )

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  })
})

/** Бот добавили в чат — сразу сообщаем админам, всё ли готово. */
bot.on('my_chat_member', async (ctx) => {
  const status = ctx.myChatMember.new_chat_member.status
  if (BigInt(ctx.chat.id) !== MAIN_CHAT_ID) return
  if (!['member', 'administrator'].includes(status)) return

  const me = await bot.api.getMe().catch(() => null)
  const sees = status === 'administrator' || (me?.can_read_all_group_messages ?? false)
  const text = [
    `🤝 Меня добавили в «${esc(ctx.chat.title ?? 'чат проекта')}» (${status}).`,
    sees
      ? '✅ Сообщения тем вижу — новые афиши и объявления барахолки начну собирать сразу.'
      : '⚠️ Но сообщения я НЕ вижу: включён privacy mode. Сделайте меня администратором ' +
        'или выключите режим у @BotFather → /setprivacy → Disable.',
  ].join('\n')

  for (const id of env.adminIds) {
    await bot.api.sendMessage(String(id), text, { parse_mode: 'HTML' }).catch(() => {})
  }
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

/* ── входящие сообщения: темы чата, фото книг, запрос к ИИ ── */

bot.on('message:photo', async (ctx) => {
  // афиша и барахолка обычно приходят картинкой с подписью
  const caption = ctx.message.caption?.trim()
  if (isEventsTopic(ctx)) return caption ? handleAnnouncement(ctx, caption) : undefined
  if (isMarketTopic(ctx)) return caption ? handleMarketPost(ctx, caption) : undefined
  // фото в личке считаем обложкой книги
  if (ctx.chat.type !== 'private') return
  await handleBookPhoto(ctx)
})

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim()
  if (text.startsWith('/')) return

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

/* ── здоровье канала записи в Notion ──────────────────────── */

/** Отправляет сообщение всем админам; молчит, если админов нет. */
async function tellAdmins(text: string) {
  for (const id of env.adminIds) {
    await bot.api
      .sendMessage(String(id), text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      })
      .catch(() => {})
  }
}

/** null — ещё не проверяли; иначе последнее известное состояние токена. */
let notionTokenOk: boolean | null = null

/**
 * NOTION_TOKEN_V2 — cookie живого аккаунта: живёт около года и слетает молча
 * (логаут, смена пароля). Раньше об этом узнавали по накопившимся карточкам
 * `pending`, то есть сильно позже. Проверяем сами и говорим админам при
 * изменении состояния — и когда сломалось, и когда починили.
 */
export async function checkNotionToken() {
  if (!notionWriteEnabled()) return
  const ok = await whoAmI()
    .then(() => true)
    .catch((e) => {
      console.error('[notion] токен не отвечает:', e?.message ?? e)
      return false
    })

  if (notionTokenOk === ok) return
  const first = notionTokenOk === null
  notionTokenOk = ok

  if (!ok) {
    const waiting = await pendingCount()
    await tellAdmins(
      [
        '🔴 <b>Notion больше не пускает</b>',
        '',
        'Cookie NOTION_TOKEN_V2 протух — новые книги в общую таблицу проекта не уходят.',
        `Уже ждут отправки: ${waiting}.`,
        '',
        'Обновите токен в <code>/opt/mnenezhalko/server/.env</code> и перезапустите службу,',
        'затем дожмите накопившееся командой /notionpush. Состояние — /notion.',
      ].join('\n'),
    )
  } else if (!first) {
    await tellAdmins('🟢 Notion снова пускает — можно дожать накопившееся: /notionpush')
  }
}

/**
 * Карточки, не уехавшие в общую таблицу, показываем админам —
 * это ровно тот случай из инструкции, когда «админы внесут сами».
 */
/**
 * По одному нику нашлось несколько незанятых записей библиотекаря — привязались
 * к главной, но остальные стоит свести вручную (или проверить, что это не разные
 * люди с похожим ником). Показываем админам, чтобы разобрались.
 */
setMergeNotifier(async (primary, others, input) => {
  if (!env.adminIds.length) return
  const who = input.username ? `@${esc(input.username)}` : `id ${input.tgId}`
  const text = [
    '🔀 <b>Похоже, дубли библиотекаря</b>',
    '',
    `Пользователь ${who} привязан к записи <b>${esc(primary.name)}</b> (${primary.id}).`,
    `Но по этому нику есть ещё записей: ${others.length}.`,
    ...others.map((o) => `• ${esc(o.name)} (${o.id})${o.notionId ? ' — в Notion' : ''}`),
    '',
    'Проверьте и при необходимости сведите записи (перенос книг на одну).',
  ].join('\n')
  for (const id of env.adminIds) {
    await bot.api
      .sendMessage(String(id), text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
      .catch(() => {})
  }
})

/**
 * Обновлённый контакт библиотекаря не уехал в Notion (протух токен, нет сети).
 * Локально он уже поправлен и стоит в очереди дожатия — сообщаем админам.
 */
setTelegramFailNotifier(async (lib, error) => {
  if (!env.adminIds.length) return
  const text = [
    '🔴 <b>Контакт не ушёл в Notion</b>',
    '',
    `Библиотекарь <b>${esc(lib.name)}</b>: новый Telegram ${lib.telegram ? '@' + esc(lib.telegram) : '—'}.`,
    'Локально поправлен и стоит в очереди. Дожать: /notionpush, состояние: /notion.',
    `Причина: ${esc(error)}`,
  ].join('\n')
  await tellAdmins(text)
})

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
    { command: 'donate', description: 'Поддержать проект звёздами' },
    { command: 'help', description: 'Помощь' },
  ])
  // постоянная кнопка Mini App слева от поля ввода
  if (webAppUrl()) {
    await bot.api.setChatMenuButton({
      menu_button: { type: 'web_app', text: 'Библиотека', web_app: { url: webAppUrl() } },
    })
  }
}
