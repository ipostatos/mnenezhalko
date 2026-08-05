import { Bot, InlineKeyboard, Keyboard } from 'grammy'
import { env, isAdmin } from './env.js'
import { prisma } from './db.js'
import { searchBooks, toCard, type BookCard } from './search.js'
import { askAi } from './ai.js'
import { syncFromNotion, setSyncAlert } from './sync.js'
import { setBookGoneNotifier } from './mydata.js'
import {
  SCOPE_TITLES,
  banUser,
  checkUserCan,
  decideReview,
  explainVerdict,
  isScope,
  flushNotices,
  logModerationAction,
  moderationQueue,
  setModerationNoticeSender,
  restrictUser,
  unbanUser,
  unrestrictUser,
  type QueueReview,
  type Scope,
} from './moderation.js'
import { plural } from './plural.js'
import {
  CITIES,
  EVENTS_TOPIC_ID,
  INSTAGRAM_URL,
  MAIN_CHAT_ID,
  MARKET_TOPIC_ID,
  eventsTopicUrl,
  marketTopicUrl,
} from './seed.js'
import { parseOffer, removeMarketItem, saveOffer } from './market.js'
import { EVENT_TAIL_MS, listPastEvents, removeEvent } from './events.js'
import { describePlace } from './agglomeration.js'
import { findPerson, personCard, projectStats } from './admin.js'
import { checkSpam } from './antispam.js'
import {
  claimLoanByToken,
  createLoan,
  listBorrowed,
  listLoans,
  loanById,
  loanMood,
  markReturned,
  reopenLoan,
  runOverdueReminders,
  summarize,
} from './loans.js'
import { leaveWaitlist, runWaitlistNotices } from './waitlist.js'
import { digest, type DigestPeriod } from './digest.js'
import { parseAnnouncement, saveAnnouncement } from './announce.js'
import { saveCoverFromTelegram } from './covers.js'
import { recognizePhoto, visionEnabled, type Recognized } from './vision.js'
import {
  approveBook,
  bookDecisionNotice,
  checkDuplicates,
  type DupCheck,
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
import { normHandle } from './notion.js'
import {
  REVIEW_TEXT_MAX,
  canReview,
  upsertReview,
  validateReview,
  workKeyOf,
} from './reviews.js'
import { lookupIsbnDetailed, looksLikeIsbn } from './isbn.js'
import { warsawTime } from './time.js'

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
  kb.url('🌸 Книжная Клумба', env.clubUrl).row()
  kb.text('💛 Поддержать проект', 'donate:menu').row()
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
  // человек пришёл по ссылке-приглашению из выдачи книги (?start=loan_<токен>)
  const payload = ctx.match?.toString().trim() ?? ''
  const claimPayload = payload.startsWith('loan_') ? payload.slice(5) : undefined

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

  if (claimPayload) {
    const result = await claimLoanByToken(BigInt(ctx.from!.id), ctx.from!.username, claimPayload)
    if (result.status === 'claimed') {
      const loan = await loanById(result.loanId)
      if (loan && loan.status === 'active') {
        await ctx.reply(
          [
            `📗 У вас книга <b>${esc(loan.title)}</b>.`,
            loan.dueAt ? `Договорились вернуть к ${loanFmt.format(loan.dueAt)}.` : '',
            '',
            // возврат отмечает владелец, когда получит книгу назад (A1): читателю
            // кнопку возврата не даём
            'Как дочитаете — верните книгу владельцу, он отметит возврат.',
          ]
            .filter(Boolean)
            .join('\n'),
          { parse_mode: 'HTML' },
        )
      }
    } else if (result.status === 'username_mismatch') {
      await ctx.reply(
        `Эта ссылка была отправлена для @${esc(result.expectedUsername ?? '?')} — ` +
          'если книга правда у вас, попросите владельца прислать ссылку вам лично.',
      )
    } else if (result.status === 'expired') {
      await ctx.reply('Эта ссылка устарела — попросите владельца прислать новую (список — /loans).')
    }
    // already_claimed / not_found — молча идём дальше к приветствию, ничего не показываем
    // постороннему по чужой или угаданной ссылке
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
      `Сейчас на полках библиотекарей <b>${total}</b> книг — открывайте библиотеку и выбирайте 👇`,
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: mainKeyboard(), link_preview_options: { is_disabled: true } },
  )
})

/**
 * Админский раздел справки.
 *
 * До 4 августа 2026 админских команд не было ВИДНО нигде: ни в /help, ни в меню
 * бота. Человек с правами не знал, что у него есть /queue, /moderation и всё
 * остальное, и пользовался только тем, что случайно увидел в переписке.
 */
const ADMIN_HELP = [
  '',
  '🛡 <b>Для администраторов</b>',
  '/stats — что происходит в проекте прямо сейчас',
  '/moderation — разбор: отзывы, книги, ограничения, блокировки',
  '/queue — книги, ждущие проверки',
  '/who <i>@ник</i> — карточка человека: полка, выдачи, ограничения',
  '/whoami — свой числовой id',
  '/admins — кто сейчас администратор',
  '/restrict <i>@ник область дней причина</i> — закрыть одно действие',
  '/unrestrict <i>@ник область причина</i> — вернуть',
  '/ban <i>@ник причина</i> · /unban <i>@ник причина</i>',
  '/market_remove <i>id причина</i> — снять объявление (или ответом на пост)',
  '/events_past · /event_remove <i>id</i> — убрать прошедшую встречу',
  '/addevent <i>Город | 2026-08-01 18:30 | Название | Место</i>',
  '/addgroup <i>Город | Название | ссылка</i>',
  '/onbehalf <i>@ник</i> — добавлять книги от имени библиотекаря',
  '/sync · /notion · /notionpush — общая таблица Notion',
  '/topics — видит ли бот чат проекта',
  '',
  'Подробное руководство: docs/ADMIN_GUIDE.md',
]

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
      '/club — книжный клуб «Книжная Клумба»',
      '/donate — поддержать проект звёздами Telegram',
      '',
      'Пришлите <b>фото книги или настолки</b> — распознаю название, автора, язык и жанр,',
      'заведу вас библиотекарем и добавлю книгу в общую таблицу проекта.',
      'Несколько книг сразу — пришлите обложки <b>альбомом</b> или списком через /import.',
      '',
      'Можно просто написать сообщение — я пойму это как запрос к помощнику.',
      ...(isAdmin(ctx.from!.id) ? ADMIN_HELP : []),
    ].join('\n'),
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
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
      'и ИИ-подбор книг — то, без чего библиотека не живёт 🌿',
      '',
      'Выберите сумму — счёт откроется прямо здесь:',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: donateKeyboard() },
  )
}

bot.command('donate', showDonateMenu)

// кнопка «Поддержать проект» из главного меню (суммы — отдельные donate:<число>)
bot.callbackQuery('donate:menu', async (ctx) => {
  await ctx.answerCallbackQuery()
  await showDonateMenu(ctx)
})

/* ── книжный клуб «Книжная Клумба» ────────────────────────── */

const clubKeyboard = () => new InlineKeyboard().url('🌸 Перейти в чат клуба', env.clubUrl)

bot.command('club', (ctx) =>
  ctx.reply(
    [
      '🌸 <b>Книжная Клумба МнеНеЖалко</b>',
      '',
      'Книжный клуб проекта: что читаем, когда встречаемся и как присоединиться.',
      'Заходите в чат клуба:',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: clubKeyboard() },
  ),
)

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

/**
 * Та же проверка прав, что и в API: ограничение должно работать и в боте, иначе
 * человек просто продолжит делать то же самое другим входом. Возвращает true,
 * если действие запрещено, и сам объясняет человеку причину.
 */
async function stoppedByRules(ctx: any, scope: Scope): Promise<boolean> {
  const v = await checkUserCan(BigInt(ctx.from.id), scope)
  if (v.allowed) return false
  const text = explainVerdict(v)
  if (ctx.callbackQuery) {
    // в всплывающем окне помещается немного, поэтому и коротко, и сообщением
    await ctx.answerCallbackQuery({ text: text.slice(0, 190), show_alert: true }).catch(() => {})
    await ctx.reply(text).catch(() => {})
  } else {
    await ctx.reply(text).catch(() => {})
  }
  return true
}

async function handleAi(ctx: any, text: string) {
  if (await stoppedByRules(ctx, 'ai')) return
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
  } catch (e: any) {
    // после «typing…» молчать нельзя — человек так и ждал ответа
    console.error('[ai] подбор упал:', e?.message ?? e)
    await ctx
      .reply('Помощник сейчас недоступен — попробуйте через пару минут или поищите через /find.')
      .catch(() => {})
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
  const [given, taken] = await Promise.all([listLoans(tgId), listBorrowed(tgId)])

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
  if (await stoppedByRules(ctx, 'add_books')) return
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
  // привязываем карточку только при ОДНОЗНАЧНОМ совпадении названия свободной
  // книги: прежний contains мог зацепить не ту (или занятую) книгу с полки
  let bookId: string | null = null
  if (own) {
    const candidates = await prisma.book.findMany({
      where: { ownerId: own.id, active: true, reviewStatus: 'approved', status: 'free' },
      select: { id: true, title: true },
      take: 300,
    })
    const nt = title.trim().toLowerCase()
    const exact = candidates.filter((b) => b.title.trim().toLowerCase() === nt)
    if (exact.length === 1) bookId = exact[0].id
  }

  try {
    const loan = await createLoan({
      ownerTg: BigInt(ctx.from!.id),
      title,
      bookId,
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
        ? 'Читателю написал. Когда вернёт книгу — возврат отметите вы, кнопкой «Уже вернулась».'
        : 'Читатель ещё не знаком с ботом. Перешлите ему ссылку, чтобы он получал напоминания:',
      // без токена ссылку не строим: раньше сюда попадал буквальный «loan_null»
      reached ? '' : loan.claimToken ? loanLink(loan.claimToken) : 'Список выдач: /loans',
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
        // возврат отмечает владелец (A1): читателю кнопку не даём
        'Как дочитаете — верните книгу владельцу, он закроет запись.',
      ].join('\n'),
      { parse_mode: 'HTML' },
    )
    .then(() => true)
    .catch(() => false)
}

// шаг 1 — спрашиваем подтверждение, чтобы не закрыть выдачу случайным тапом
bot.callbackQuery(/^loan:back:(.+)$/, async (ctx) => {
  const id = ctx.match![1]
  const loan = await loanById(id)
  if (!loan || loan.status !== 'active') {
    return ctx.answerCallbackQuery({ text: 'Эта запись уже закрыта' })
  }
  await ctx.answerCallbackQuery()
  await ctx
    .editMessageReplyMarkup({
      reply_markup: new InlineKeyboard()
        .text('Да, вернулась', `loan:yes:${id}`)
        .text('Отмена', `loan:no:${id}`),
    })
    .catch(() => {})
})

// шаг 2 — подтверждено: закрываем выдачу и даём отменить в течение суток
bot.callbackQuery(/^loan:yes:(.+)$/, async (ctx) => {
  const id = ctx.match![1]
  let loan
  try {
    loan = await markReturned(id, BigInt(ctx.from.id))
  } catch (e: any) {
    // возврат подтверждает только владелец книги (A1): читателю мягкий отказ
    if (e?.message === 'forbidden')
      return ctx.answerCallbackQuery({ text: 'Возврат отмечает владелец книги, когда получит её назад' })
    throw e
  }
  if (!loan) return ctx.answerCallbackQuery({ text: 'Эта запись уже закрыта' })
  await ctx.answerCallbackQuery({ text: 'Книга дома 🎉' })
  await ctx.editMessageText(`✅ «${esc(loan.title)}» вернулась. Спасибо!`, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('↩️ Отменить возврат', `loan:undo:${id}`),
  })
  const other = ctx.from.id === Number(loan.ownerTg) ? loan.holderTg : loan.ownerTg
  if (other) {
    await bot.api
      .sendMessage(String(other), `✅ «${loan.title}» отмечена как вернувшаяся.`)
      .catch(() => {})
  }
  await askForRating(loan)
  // книга освободилась — обещание тем, кто её ждал (issue #10)
  void flushWaitlistNotices().catch(() => {})
})

/* ── оценка книги после прочтения (issue #18) ─────────────── */

/**
 * Оценку спрашиваем ровно один раз и только у читателя: он книгу прочитал,
 * владелец — не обязательно. Молчим, если выдача была «по названию», без
 * карточки в каталоге: оценивать нечего, показать её будет негде.
 */
export async function askForRating(loan: { holderTg: bigint | null; bookId: string | null }) {
  if (!loan.holderTg || !loan.bookId) return
  const book = await prisma.book.findUnique({
    where: { id: loan.bookId },
    select: { id: true, title: true, active: true },
  })
  if (!book?.active) return
  await bot.api
    .sendMessage(
      String(loan.holderTg),
      [
        `📖 Как вам «${esc(book.title)}»?`,
        '',
        'Поставьте оценку — её увидят все, кто ищет эту книгу в библиотеке.',
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: starsKeyboard(book.id) },
    )
    .catch(() => {})
}

/* ── очередь на занятую книгу (issue #10) ─────────────────── */

/**
 * Разослать тем, кому книга освободилась.
 *
 * Зовётся сразу после возврата (из бота и из Mini App) и, кроме того, джобой:
 * список берётся из базы, поэтому повтор ничего не задваивает, а обещание не
 * теряется, если ровно в этот момент процесс перезапустили.
 */
export async function flushWaitlistNotices(limit = 50) {
  return runWaitlistNotices({
    limit,
    delayMs: 40,
    send: (chatId, text, opts) => bot.api.sendMessage(chatId, text, opts as never),
    bookUrl: (bookId) => (webAppUrl() ? `${webAppUrl()}/?screen=book&id=${bookId}` : null),
  })
}

bot.callbackQuery(/^wait:stop:(.+)$/, async (ctx) => {
  const bookId = ctx.match![1]
  await leaveWaitlist(BigInt(ctx.from.id), bookId)
  await ctx.answerCallbackQuery({ text: 'Больше не напоминаю' })
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
})

const starsKeyboard = (bookId: string) => {
  const kb = new InlineKeyboard()
  for (let n = 1; n <= 5; n++) kb.text('⭐'.repeat(n), `rev:${bookId}:${n}`).row()
  return kb
}

const starsLine = (n: number) => '⭐'.repeat(n) + '☆'.repeat(5 - n)

/**
 * Кто сейчас пишет аннотацию: tgId → книга и когда попросили. В памяти, как и
 * черновики полки: потеря при рестарте не страшна, человек просто нажмёт
 * кнопку ещё раз, а забытый диалог не должен ловить случайное сообщение через
 * неделю.
 */
const reviewTextWait = new Map<number, { bookId: string; at: number }>()
const REVIEW_WAIT_TTL_MS = 2 * 3600_000

bot.callbackQuery(/^rev:([^:]+):([1-5])$/, async (ctx) => {
  if (await stoppedByRules(ctx, 'reviews')) return
  const bookId = ctx.match![1]
  const rating = Number(ctx.match![2])
  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: { id: true, title: true, author: true },
  })
  if (!book) return ctx.answerCallbackQuery({ text: 'Книга не найдена' })

  const tgId = BigInt(ctx.from.id)
  if (!(await canReview(tgId, workKeyOf(book)))) {
    return ctx.answerCallbackQuery({
      text: 'Оценку ставит тот, кто книгу читал',
      show_alert: true,
    })
  }

  await upsertReview({ authorTg: tgId, book, rating, text: null })
  reviewTextWait.set(ctx.from.id, { bookId, at: Date.now() })
  await ctx.answerCallbackQuery({ text: 'Спасибо!' })
  await ctx
    .editMessageText(
      [
        `📖 «${esc(book.title)}» — ваша оценка: ${starsLine(rating)}`,
        '',
        'Если хотите, напишите пару слов о книге — следующим сообщением. ' +
          `Не больше ${REVIEW_TEXT_MAX} знаков, увидят все.`,
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: starsKeyboard(book.id) },
    )
    .catch(() => {})
})

/** Аннотация пришла обычным сообщением — дописываем её к своей оценке. */
async function handleReviewText(ctx: any, text: string): Promise<boolean> {
  const wait = reviewTextWait.get(ctx.from.id)
  if (!wait) return false
  if (Date.now() - wait.at > REVIEW_WAIT_TTL_MS) {
    reviewTextWait.delete(ctx.from.id)
    return false
  }
  const book = await prisma.book.findUnique({
    where: { id: wait.bookId },
    select: { id: true, title: true, author: true },
  })
  if (!book) {
    reviewTextWait.delete(ctx.from.id)
    return false
  }

  const tgId = BigInt(ctx.from.id)
  const mine = await prisma.review.findUnique({
    where: { workKey_authorTg: { workKey: workKeyOf(book), authorTg: tgId } },
    select: { rating: true },
  })
  // оценки нет — значит человек её удалил или это чужая переписка: не молчим,
  // но и не придумываем оценку за него
  if (!mine) {
    reviewTextWait.delete(ctx.from.id)
    await ctx.reply('Сначала поставьте оценку книге, потом добавлю к ней текст.')
    return true
  }

  let parsed
  try {
    parsed = validateReview({ rating: mine.rating, text })
  } catch (e: any) {
    const msg: Record<string, string> = {
      text_too_long: `Слишком длинно: не больше ${REVIEW_TEXT_MAX} знаков. Пришлите покороче.`,
      links_not_allowed: 'Ссылки в отзывах не публикуем. Пришлите текст без ссылки.',
    }
    await ctx.reply(msg[e?.message] ?? 'Не получилось сохранить, попробуйте ещё раз.')
    return true
  }

  await upsertReview({ authorTg: tgId, book, rating: mine.rating, text: parsed.text })
  reviewTextWait.delete(ctx.from.id)
  await ctx.reply(
    `Записал: ${starsLine(mine.rating)} «${esc(book.title)}». Спасибо, это помогает выбирать.`,
    { parse_mode: 'HTML' },
  )
  return true
}

// отмена подтверждения — возвращаем обычную кнопку
bot.callbackQuery(/^loan:no:(.+)$/, async (ctx) => {
  const id = ctx.match![1]
  await ctx.answerCallbackQuery({ text: 'Оставил как есть' })
  await ctx
    .editMessageReplyMarkup({
      reply_markup: new InlineKeyboard().text('✅ Книга вернулась', `loan:back:${id}`),
    })
    .catch(() => {})
})

// undo возврата
bot.callbackQuery(/^loan:undo:(.+)$/, async (ctx) => {
  const id = ctx.match![1]
  let r
  try {
    r = await reopenLoan(id, BigInt(ctx.from.id))
  } catch (e: any) {
    // гонка с параллельной выдачей той же книги (unique activeBookId)
    if (e?.code === 'P2002') return ctx.answerCallbackQuery({ text: 'Книга уже выдана другому' })
    throw e
  }
  if ('error' in r) {
    const msg: Record<string, string> = {
      too_late: 'Отменить уже нельзя — прошло больше суток',
      book_relent: 'Книга уже выдана другому',
      not_returned: 'Эта выдача снова активна',
      forbidden: 'Это не ваша выдача',
      not_found: 'Не нашёл выдачу',
    }
    return ctx.answerCallbackQuery({ text: msg[r.error as string] ?? 'Не получилось' })
  }
  await ctx.answerCallbackQuery({ text: 'Возврат отменён' })
  await ctx.editMessageText(`↩️ «${esc(r.loan.title)}» снова числится у читателя.`, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('✅ Книга вернулась', `loan:back:${id}`),
  })
  const other = ctx.from.id === Number(r.loan.ownerTg) ? r.loan.holderTg : r.loan.ownerTg
  if (other) {
    await bot.api.sendMessage(String(other), `↩️ Возврат «${r.loan.title}» отменён.`).catch(() => {})
  }
})

/**
 * Раз в сутки напоминаем про просроченные книги — мягко, обеим сторонам,
 * и не чаще раза в неделю по одной выдаче.
 */
export async function remindOverdueLoans(now?: Date) {
  const r = await runOverdueReminders({
    now,
    botUsername: BOT_USERNAME,
    delayMs: 50, // Telegram не любит больше ~30 сообщений в секунду
    send: (chatId, text, opts) => bot.api.sendMessage(chatId, text, opts as any),
  })
  if (r.loans) console.log(`[loans] напомнил по ${r.loans} выдачам`)
  return r
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
  for (const [i, e] of events.entries()) {
    const created = await saveAnnouncement(e, ctx.message.message_id, i)
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
      startsAt: { gte: new Date(Date.now() - EVENT_TAIL_MS) },
      // снятая админом встреча пропадает и здесь: у бота и Mini App
      // не должно быть двух разных представлений об афише
      removedAt: null,
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
  locality: string | null
  description: string | null
  authorUsername: string | null
  authorTg: bigint
}): string {
  // город неизвестен, а посёлок назван — показываем хотя бы посёлок:
  // «Все города» рядом с вещью, которую человек уже как-то описал, ничего не говорит
  const where =
    i.city !== 'Все города' ? describePlace(i.city, i.locality) : (i.locality ?? null)
  const meta = [i.price, where].filter(Boolean).join(' · ')
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

// обложки может не быть вовсе: книга, найденная по ISBN в каталоге без картинки
type ShelfDraft = Recognized & { coverUrl: string | null }
const shelfDrafts = new Map<number, ShelfDraft>()

/**
 * TTL диалоговых черновиков: карточки «поставить на полку» и пачки с фото
 * живут в памяти — забытый черновик не должен висеть вечно (и внезапно
 * сработать через неделю по старой кнопке). Потеря при рестарте не страшна:
 * бот честно попросит прислать фото ещё раз.
 */
const DRAFT_TTL_MS = 2 * 3600_000
const draftTouched = new Map<number, number>()
const touchDraft = (tgId: number) => draftTouched.set(tgId, Date.now())
const draftSweeper = setInterval(() => {
  const cutoff = Date.now() - DRAFT_TTL_MS
  for (const [tgId, at] of draftTouched) {
    if (at < cutoff) {
      draftTouched.delete(tgId)
      shelfDrafts.delete(tgId)
      shelfBatches.delete(tgId)
    }
  }
}, 30 * 60_000)
draftSweeper.unref?.()

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

/**
 * Приписка про дубли к карточке книги. Города перечисляем с числами: раньше
 * писали общее количество рядом с одним городом («3 экземпляра в Варшаве»),
 * хотя экземпляры стояли в разных городах.
 */
const duplicatesText = (dup: DupCheck) => {
  let t = ''
  if (dup.own) {
    t += '\n\n⚠️ Такая книга у вас уже есть на полке. Добавляйте, только если это второй экземпляр.'
  }
  const n = dup.others.count
  if (n) {
    const where = dup.others.where
    t +=
      `\n\n📚 В библиотеке уже есть ещё ${n} ${plural(n, ['экземпляр', 'экземпляра', 'экземпляров'])}` +
      `${where ? ` — ${esc(where)}` : ''}. Это нормально, добавляйте свой.`
  }
  return t
}

const shelfKeyboard = () => {
  const kb = new InlineKeyboard().text('✅ Поставить на полку', 'shelf:save').row()
  if (webAppUrl()) kb.webApp('✏️ Уточнить в приложении', `${webAppUrl()}/?screen=add`)
  return kb
}

/** Несколько книг с одного фото ждут подтверждения владельца. */
const shelfBatches = new Map<number, Recognized[]>()

const batchKeyboard = (n: number) =>
  new InlineKeyboard().text(`✅ Добавить все (${n})`, 'shelfbatch:save').row().text('Отмена', 'shelfbatch:no')

/** Список найденных на фото книг с пометками про корешки и свои дубли. */
async function batchCard(books: Recognized[], ownerTg: bigint) {
  const lines: string[] = []
  for (const [i, b] of books.entries()) {
    const dup = await checkDuplicates({
      title: b.title,
      author: b.author,
      kind: b.kind === 'game' ? 'game' : 'book',
      ownerTg,
    })
    const marks = [
      b.spine ? '<i>по корешку</i>' : '',
      b.confidence === 'low' ? '<i>плохо видно</i>' : '',
      dup.own ? '⚠️ <i>уже на вашей полке</i>' : '',
    ].filter(Boolean)
    lines.push(
      `${i + 1}. <b>${esc(b.title)}</b>${b.author ? ' — ' + esc(b.author) : ''}` +
        (marks.length ? `\n    ${marks.join(' · ')}` : ''),
    )
  }
  return lines.join('\n')
}

/** Фото книги в личке: распознаём (одну или сразу все) и предлагаем поставить на полку. */
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

  const r = await recognizePhoto(saved.decoded.data, saved.decoded.mediaType).catch((e: any) => {
    console.error('[vision] ошибка распознавания:', e?.message ?? e)
    return null
  })
  if (!r || !r.books.length) {
    return ctx.reply(
      r?.note
        ? `Не разобрал книгу: ${esc(r.note)}`
        : 'Не разобрал, что на фото. Переснимите так, чтобы читались название и автор.',
      { parse_mode: 'HTML' },
    )
  }

  // админ в режиме «от имени» должен видеть это ДО сохранения, а не после
  const ob = await behalfFor(ctx)
  const behalfNote = ob ? `\n<i>Добавится на полку: ${esc(ob.name)}</i>` : ''

  // на фото несколько книг (стопка или полка корешками) — подтверждаем списком
  if (r.books.length > 1) {
    shelfDrafts.delete(ctx.from.id)
    shelfBatches.set(ctx.from.id, r.books)
    touchDraft(ctx.from.id)
    const card = await batchCard(r.books, BigInt(ctx.from.id))
    const tail = [
      r.note ? `\n\n<i>${esc(r.note)}</i>` : '',
      '\n\nОбложку с общего фото не ставлю — на нём несколько книг. Нужна обложка — пришлите книгу отдельным снимком.',
      behalfNote,
    ].join('')
    return ctx.reply(
      `Нашёл ${r.books.length} ${plural(r.books.length, ['книгу', 'книги', 'книг'])}:\n\n${card}${tail}`,
      { parse_mode: 'HTML', reply_markup: batchKeyboard(r.books.length) },
    )
  }

  const recognized = r.books[0]
  shelfBatches.delete(ctx.from.id)
  shelfDrafts.set(ctx.from.id, { ...recognized, note: r.note, coverUrl: saved.url })
  touchDraft(ctx.from.id)

  const dup = await checkDuplicates({
    title: recognized.title,
    author: recognized.author,
    kind: recognized.kind === 'game' ? 'game' : 'book',
    ownerTg: BigInt(ctx.from.id),
  })
  await ctx.reply(
    `Похоже, это:\n\n${shelfCard(shelfDrafts.get(ctx.from.id)!)}${duplicatesText(dup)}${behalfNote}`,
    {
      parse_mode: 'HTML',
      reply_markup: shelfKeyboard(),
    },
  )
}

/**
 * Совет человеку, когда ISBN не нашёлся. Русские издания открытые каталоги
 * покрывают плохо (OpenLibrary их почти не знает, Google Books без ключа
 * отвечает 429), поэтому не отмалчиваемся, а предлагаем рабочий путь.
 */
const ISBN_MISS_HINT =
  'Пришлите фото обложки — распознаю по нему, либо строкой: <code>Название — Автор</code>.'

/** Одиночный ISBN сообщением: ищем в каталогах и предлагаем поставить на полку. */
async function handleIsbnMessage(ctx: any, raw: string) {
  if (await stoppedByRules(ctx, 'add_books')) return
  await ctx.replyWithChatAction('typing')
  const r = await lookupIsbnDetailed(raw).catch((e: any) => {
    console.error('[isbn] поиск упал:', e?.message ?? e)
    return null
  })
  if (!r?.book) {
    // «каталог сейчас лежит» и «книги нет» — разные новости для человека
    const why = r?.serviceDown
      ? `Каталог книг сейчас не отвечает — попробуйте ещё раз через минуту.`
      : `Не нашёл книгу по ISBN <code>${esc(raw)}</code> в открытых каталогах.`
    return ctx.reply(`${why}\n\n${ISBN_MISS_HINT}`, { parse_mode: 'HTML' })
  }

  const draft: ShelfDraft = {
    recognized: true,
    kind: 'book',
    title: r.book.title,
    author: r.book.author,
    languages: [],
    genres: [],
    confidence: 'high',
    note: null,
    coverUrl: r.book.coverUrl,
  }
  shelfDrafts.set(ctx.from.id, draft)
  touchDraft(ctx.from.id)

  const dup = await checkDuplicates({
    title: draft.title,
    author: draft.author,
    kind: 'book',
    ownerTg: BigInt(ctx.from.id),
  })

  const ob = await behalfFor(ctx)
  const behalfNote = ob ? `\n<i>Добавится на полку: ${esc(ob.name)}</i>` : ''
  await ctx.reply(`Нашёл по ISBN:\n\n${shelfCard(draft)}${duplicatesText(dup)}${behalfNote}`, {
    parse_mode: 'HTML',
    reply_markup: shelfKeyboard(),
  })
}

/* ── пакетное добавление: альбом фотографий и список ─────── */

/**
 * Фото из Telegram-альбома приходят отдельными апдейтами с общим media_group_id.
 * Копим их с дебаунсом и обрабатываем всю пачку разом, а не как N отдельных книг.
 */
type AlbumBuf = { fileIds: string[]; timer: ReturnType<typeof setTimeout>; ctx: any }
const albums = new Map<string, AlbumBuf>()
const ALBUM_WAIT_MS = 1500

/**
 * Админ добавляет книги от имени библиотекаря (пока не сбросит /onbehalf off).
 *
 * Состояние ПЕРСИСТЕНТНОЕ (SyncState) с TTL: раньше жило только в памяти, и
 * после незаметного рестарта (деплоя) админ молча продолжал добавлять книги
 * уже СЕБЕ. Память — только кэш поверх базы.
 */
type BehalfState = { id: string; name: string; city: string | null; at: number }
const ONBEHALF_TTL_MS = 12 * 3600_000
const onBehalf = new Map<number, BehalfState>()
const behalfKey = (tgId: number) => `onbehalf:${tgId}`

async function setBehalf(tgId: number, value: BehalfState | null): Promise<void> {
  if (value) onBehalf.set(tgId, value)
  else onBehalf.delete(tgId)
  const key = behalfKey(tgId)
  try {
    if (value) {
      await prisma.syncState.upsert({
        where: { key },
        create: { key, value: JSON.stringify(value) },
        update: { value: JSON.stringify(value) },
      })
    } else {
      await prisma.syncState.deleteMany({ where: { key } })
    }
  } catch (e: any) {
    console.error('[onbehalf] состояние не сохранилось:', e?.message ?? e)
  }
}

/** Активный режим «от имени» с учётом рестарта и TTL; истёкший — сбрасывается. */
async function behalfFor(ctx: any): Promise<BehalfState | undefined> {
  if (!isAdmin(ctx.from.id)) return undefined
  const tgId = ctx.from.id as number
  let state = onBehalf.get(tgId)
  if (!state) {
    const row = await prisma.syncState.findUnique({ where: { key: behalfKey(tgId) } }).catch(() => null)
    if (!row) return undefined
    try {
      state = JSON.parse(row.value) as BehalfState
      onBehalf.set(tgId, state)
    } catch {
      await setBehalf(tgId, null)
      return undefined
    }
  }
  if (Date.now() - state.at > ONBEHALF_TTL_MS) {
    await setBehalf(tgId, null)
    await ctx
      .reply(`Режим «от имени ${esc(state.name)}» истёк — добавляю снова от вашего имени. Вернуть: /onbehalf @ник.`, { parse_mode: 'HTML' })
      .catch(() => {})
    return undefined
  }
  return state
}

function bufferAlbumPhoto(ctx: any) {
  const key = `${ctx.chat.id}:${ctx.message.media_group_id}`
  const fileId = ctx.message.photo.at(-1)!.file_id
  const prev = albums.get(key)
  if (prev) clearTimeout(prev.timer)
  const fileIds = prev ? [...prev.fileIds, fileId] : [fileId]
  const timer = setTimeout(() => {
    albums.delete(key)
    handlePhotoBatch(ctx, fileIds).catch((e) => console.error('[batch] альбом:', e?.message ?? e))
  }, ALBUM_WAIT_MS)
  albums.set(key, { fileIds, timer, ctx })
}

/** Распознаёт и ставит на полку пачку обложек; в конце — одна сводка. */
async function handlePhotoBatch(ctx: any, fileIds: string[]) {
  if (!visionEnabled()) {
    return ctx.reply('Распознавание по фото сейчас недоступно. Добавьте книги вручную в приложении.')
  }
  const ob = await behalfFor(ctx)
  const user = await prisma.user.findUnique({ where: { tgId: BigInt(ctx.from.id) } })
  if (!ob && !user?.city) {
    return ctx.reply(
      'Чтобы добавить пачкой, сначала выберите город: /city — потом пришлите обложки книг альбомом.',
    )
  }
  const ids = fileIds.slice(0, 10) // Telegram-альбом — максимум 10
  await ctx.reply(`Разбираю ${ids.length} ${plural(ids.length, ['обложку', 'обложки', 'обложек'])}…`)
  await ctx.replyWithChatAction('typing')

  const added: string[] = []
  const pending: string[] = []
  let failed = 0
  for (const fileId of ids) {
    const saved = await saveCoverFromTelegram(fileId).catch(() => null)
    const rec = saved
      ? await recognizePhoto(saved.decoded.data, saved.decoded.mediaType).catch(() => null)
      : null
    if (!saved || !rec || !rec.books.length) {
      failed++
      continue
    }
    for (const b of rec.books) {
      const res = await putOnShelf({
        tgId: BigInt(ctx.from.id),
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
        kind: b.kind,
        title: b.title,
        author: b.author,
        genres: b.genres,
        languages: b.languages,
        city: ob ? null : user!.city,
        // общий кадр со стопкой обложкой конкретной книги не является
        coverUrl: rec.books.length === 1 ? saved.url : null,
        ownerLibrarianId: ob?.id,
      })
      ;(res.book.reviewStatus === 'pending' ? pending : added).push(res.book.title)
    }
  }
  await sendBatchSummary(ctx, added, pending, failed, ob?.name)
}

/** Пакетное добавление списком: `/import` + строки «Название — Автор». */
async function handleListImport(ctx: any, raw: string) {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 1)
    .slice(0, 30)
  if (!lines.length) {
    return ctx.reply(
      [
        '<b>Пакетное добавление</b>',
        '',
        'Пришлите обложки книг <b>альбомом</b> — распознаю и добавлю пачкой.',
        'Или списком, по одной на строку — названием или ISBN:',
        '<code>/import',
        'Дюна — Фрэнк Герберт',
        '9785171147426</code>',
        '',
        'По ISBN сам подтяну название, автора и обложку.',
      ].join('\n'),
      { parse_mode: 'HTML' },
    )
  }
  const ob = await behalfFor(ctx)
  const user = await prisma.user.upsert({
    where: { tgId: BigInt(ctx.from.id) },
    create: {
      tgId: BigInt(ctx.from.id),
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      isAdmin: isAdmin(ctx.from.id),
    },
    update: { username: ctx.from.username },
  })
  if (!ob && !user.city) return ctx.reply('Сначала выберите город: /city — потом повторите список.')

  await ctx.replyWithChatAction('typing')
  const added: string[] = []
  const pending: string[] = []
  const missedIsbn: string[] = []
  let quotaBlocked = false
  let failed = 0
  for (const line of lines) {
    let book: { title: string; author: string | null; coverUrl: string | null } | null = null
    if (looksLikeIsbn(line)) {
      const found = await lookupIsbnDetailed(line).catch(() => null)
      if (found?.book) book = found.book
      else {
        // не молча в «не разобрал»: человек должен видеть, какой именно ISBN не нашёлся
        missedIsbn.push(line)
        if (found?.quotaBlocked) quotaBlocked = true
        continue
      }
    } else {
      const [title, author] = line.split(/\s[—–-]\s|\s*\|\s*/).map((s) => s.trim())
      if (!title || title.length < 2) {
        failed++ // строка «Не разобрал: N» в сводке была недостижима
        continue
      }
      book = { title, author: author || null, coverUrl: null }
    }
    const res = await putOnShelf({
      tgId: BigInt(ctx.from.id),
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
      kind: 'book',
      title: book.title,
      author: book.author,
      genres: [],
      languages: [],
      city: ob ? null : user.city,
      coverUrl: book.coverUrl,
      ownerLibrarianId: ob?.id,
    })
    ;(res.book.reviewStatus === 'pending' ? pending : added).push(res.book.title)
  }
  await sendBatchSummary(ctx, added, pending, failed, ob?.name, { missedIsbn, quotaBlocked })
}

/** Общая сводка после пакетного добавления. */
async function sendBatchSummary(
  ctx: any,
  added: string[],
  pending: string[],
  failed: number,
  behalfName?: string,
  isbn?: { missedIsbn: string[]; quotaBlocked: boolean },
) {
  const blocks: string[] = []
  if (behalfName) blocks.push(`<i>От имени: ${esc(behalfName)}</i>`)
  if (added.length)
    blocks.push(`🎉 На полке (${added.length}):\n` + added.map((t) => `• ${esc(t)}`).join('\n'))
  if (pending.length)
    blocks.push(
      `📖 На проверке модератора (${pending.length}):\n` +
        pending.map((t) => `• ${esc(t)}`).join('\n'),
    )
  if (isbn?.missedIsbn.length) {
    blocks.push(
      `🔍 Не нашёл по ISBN (${isbn.missedIsbn.length}):\n` +
        isbn.missedIsbn.map((i) => `• <code>${esc(i)}</code>`).join('\n') +
        `\n\n${ISBN_MISS_HINT}`,
    )
  }
  if (isbn?.quotaBlocked && isAdmin(ctx.from.id)) {
    blocks.push(
      '<i>Google Books ответил 429 (общая анонимная квота). Пока не задан GOOGLE_BOOKS_KEY, ' +
        'русские издания по ISBN почти не находятся.</i>',
    )
  }
  if (failed) blocks.push(`⚠️ Не разобрал: ${failed}. Пришлите их поштучно и покрупнее.`)
  if (added.length === 0 && pending.length === 0) blocks.push('Ничего не удалось добавить.')
  await ctx.reply(blocks.join('\n\n'), { parse_mode: 'HTML', reply_markup: mainKeyboard() })
}

bot.command('import', async (ctx) => {
  if (await stoppedByRules(ctx, 'add_books')) return
  return handleListImport(ctx, ctx.match?.toString() ?? '')
})

/** Админ: добавлять книги от имени библиотекаря (фото/альбом/список/ISBN). */
bot.command('onbehalf', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return
  const arg = ctx.match?.toString().trim() ?? ''
  if (!arg || /^(off|стоп|сброс)$/i.test(arg)) {
    await setBehalf(ctx.from!.id, null)
    return ctx.reply('Ок, добавляю снова от своего имени.')
  }
  const nick = normHandle(arg)
  if (!nick) {
    return ctx.reply('Формат: <code>/onbehalf @ник</code> библиотекаря (сброс — /onbehalf off).', {
      parse_mode: 'HTML',
    })
  }
  const lib = await prisma.librarian.findFirst({
    where: { telegramNorm: nick, mergedIntoId: null },
    select: { id: true, name: true, city: true },
  })
  if (!lib) {
    return ctx.reply(
      `Не нашёл библиотекаря @${esc(nick)}. Он должен уже быть в базе — из Notion или добавив хотя бы одну книгу.`,
      { parse_mode: 'HTML' },
    )
  }
  await setBehalf(ctx.from!.id, { id: lib.id, name: lib.name, city: lib.city, at: Date.now() })
  await ctx.reply(
    `Теперь книги (фото, альбом, список, ISBN) добавляю от имени <b>${esc(lib.name)}</b>` +
      `${lib.city ? ` · ${esc(lib.city)}` : ''}.\n` +
      'Режим переживает перезапуски и сам сбросится через 12 часов. Сбросить — /onbehalf off.',
    { parse_mode: 'HTML' },
  )
})

bot.callbackQuery('shelf:save', async (ctx) => {
  const d = shelfDrafts.get(ctx.from.id)
  if (!d) return ctx.answerCallbackQuery({ text: 'Пришлите фото книги ещё раз' })

  // админ добавляет от имени библиотекаря — город берём у него, не спрашиваем
  const ob = await behalfFor(ctx)
  if (ob) {
    await ctx.answerCallbackQuery({ text: 'Ставлю на полку…' })
    return saveShelfDraft(ctx, d, ob.city ?? '', ob)
  }

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

/** Подтверждение пачки книг с одного фото. */
bot.callbackQuery('shelfbatch:save', async (ctx) => {
  if (await stoppedByRules(ctx, 'add_books')) return
  const books = shelfBatches.get(ctx.from.id)
  if (!books?.length) return ctx.answerCallbackQuery({ text: 'Пришлите фото ещё раз' })

  const ob = await behalfFor(ctx)
  if (ob) {
    await ctx.answerCallbackQuery({ text: 'Ставлю на полку…' })
    return saveShelfBatch(ctx, books, ob.city ?? '', ob)
  }

  const user = await prisma.user.findUnique({ where: { tgId: BigInt(ctx.from.id) } })
  if (!user?.city) {
    const kb = new InlineKeyboard()
    CITIES.forEach((c, i) => {
      kb.text(c, `shelfcity:${c}`)
      if (i % 2 === 1) kb.row()
    })
    await ctx.answerCallbackQuery()
    return ctx.reply('В каком городе стоят книги?', { reply_markup: kb })
  }

  await ctx.answerCallbackQuery({ text: 'Ставлю на полку…' })
  await saveShelfBatch(ctx, books, user.city)
})

bot.callbackQuery('shelfbatch:no', async (ctx) => {
  shelfBatches.delete(ctx.from.id)
  await ctx.answerCallbackQuery({ text: 'Отменил' })
  await ctx.reply('Ок, ничего не добавил. Пришлите книги по одной, если так удобнее.')
})

/** Ставит на полку все подтверждённые книги с фото; обложки у них нет (общий кадр). */
async function saveShelfBatch(
  ctx: any,
  books: Recognized[],
  city: string,
  ob?: { id: string; name: string },
) {
  shelfBatches.delete(ctx.from.id)
  const added: string[] = []
  const pending: string[] = []
  for (const b of books) {
    const res = await putOnShelf({
      tgId: BigInt(ctx.from.id),
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
      kind: b.kind,
      title: b.title,
      author: b.author,
      genres: b.genres,
      languages: b.languages,
      city: ob ? null : city,
      coverUrl: null,
      ownerLibrarianId: ob?.id,
    })
    ;(res.book.reviewStatus === 'pending' ? pending : added).push(res.book.title)
  }
  await sendBatchSummary(ctx, added, pending, 0, ob?.name)
}

bot.callbackQuery(/^shelfcity:(.+)$/, async (ctx) => {
  const batch = shelfBatches.get(ctx.from.id)
  const d = shelfDrafts.get(ctx.from.id)
  if (!batch?.length && !d) return ctx.answerCallbackQuery({ text: 'Пришлите фото книги ещё раз' })
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
  // город спрашивали либо под одну книгу, либо под пачку с общего фото
  if (batch?.length) return saveShelfBatch(ctx, batch, city)
  await saveShelfDraft(ctx, d!, city)
})

async function saveShelfDraft(
  ctx: any,
  d: ShelfDraft,
  city: string,
  ob?: { id: string; name: string },
) {
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
    city: ob ? null : city,
    coverUrl: d.coverUrl,
    ownerLibrarianId: ob?.id,
  })
  const behalf = ob ? ` (от имени ${esc(ob.name)})` : ''

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

  await ctx.reply(`🎉 Готово! «${esc(res.book.title)}» на полке${behalf}.\n${inNotion}`, {
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

// подозрительный синк (массовое исчезновение книг) — предупреждаем админов
setSyncAlert((msg) => {
  for (const id of env.adminIds) {
    bot.api.sendMessage(String(id), msg, { link_preview_options: { is_disabled: true } }).catch(() => {})
  }
})

/**
 * Владелец удалил свои данные, его книги ушли с полки. Тем, кто ждал такую
 * книгу, отправляем нейтральное сообщение: человек ждёт обещанного письма, и
 * молчание выглядело бы как поломка. Почему книги не стало — не их дело.
 */
setBookGoneNotifier(async (notices) => {
  for (const n of notices) {
    await bot.api
      .sendMessage(
        String(n.userTg),
        [
          `📕 Книга «${esc(n.title)}» больше недоступна в библиотеке.`,
          '',
          'Вы её ждали, поэтому предупреждаем. Возможно, такая же есть у кого-то ещё:',
        ].join('\n'),
        {
          parse_mode: 'HTML',
          // ведём в библиотеку, а не в никуда: возможно, такая книга есть у другого
          reply_markup: webAppUrl()
            ? new InlineKeyboard().webApp('📚 Поискать в библиотеке', webAppUrl())
            : undefined,
        },
      )
      .catch(() => {})
  }
})

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

  // карточка уходит каждому админу: повторный тап и второй админ — штатные случаи
  if (res.status === 'not_found') return ctx.answerCallbackQuery({ text: 'Книга не найдена' })
  if (res.status === 'in_progress') {
    return ctx.answerCallbackQuery({ text: 'Уже одобряется другим админом' })
  }
  if (res.status === 'bad_state') {
    return ctx.answerCallbackQuery({
      text: res.reviewStatus === 'rejected' ? 'Книга уже отклонена' : 'Книга удалена',
    })
  }
  if (res.status === 'failed') {
    return ctx.answerCallbackQuery({ text: `Не получилось: ${res.error.slice(0, 150)}` })
  }

  if (res.already) {
    await ctx.answerCallbackQuery({ text: 'Уже одобрено ✅' })
    await ctx
      .editMessageText(`✅ Одобрено: «${esc(res.card.title)}» — теперь в каталоге.`, {
        parse_mode: 'HTML',
      })
      .catch(() => {})
    return // владельцу второй раз не пишем
  }

  await ctx.answerCallbackQuery({ text: 'Одобрено ✅' })
  await ctx.editMessageText(`✅ Одобрено: «${esc(res.card.title)}» — теперь в каталоге.`, {
    parse_mode: 'HTML',
  })
  if (res.addedByTg) {
    // текст один на бота и на админский экран (bookDecisionNotice в publish.ts)
    await bot.api
      .sendMessage(String(res.addedByTg), bookDecisionNotice('approve', esc(res.card.title)), {
        parse_mode: 'HTML',
        reply_markup: mainKeyboard(),
      })
      .catch(() => {})
  }
})

bot.callbackQuery(/^mod:no:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Только для админов' })
  const res = await rejectBook(ctx.match![1], BigInt(ctx.from.id), null)
  if (!res) {
    return ctx.answerCallbackQuery({ text: 'Книга не найдена или уже одобряется другим админом' })
  }
  await ctx.answerCallbackQuery({ text: 'Отклонено' })
  await ctx.editMessageText(`❌ Отклонено: «${esc(res.card.title)}».`, { parse_mode: 'HTML' })
  if (res.addedByTg) {
    await bot.api
      .sendMessage(String(res.addedByTg), bookDecisionNotice('reject', esc(res.card.title)), {
        parse_mode: 'HTML',
      })
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

/* ── разбор жалоб и ограничения участников ───────────────── */

/**
 * Уведомление человеку о решении модератора. Ровно одно на решение:
 * идемпотентность обеспечивают сами функции модерации (повторное нажатие
 * возвращает `already_*` и сюда не доходит). Кто пожаловался — не раскрываем.
 */
async function tellUser(tgId: bigint, text: string) {
  await bot.api.sendMessage(String(tgId), text).catch(() => {})
}

// решения, принятые через API (админский экран), доходят до человека тем же путём
setModerationNoticeSender(tellUser)

/** Карточка отзыва для разбора: текст, автор, число УНИКАЛЬНЫХ жалоб, прошлые решения. */
function reviewCard(r: QueueReview) {
  const lines = [
    r.status === 'hidden' ? '🙈 <b>Отзыв скрыт автоматически</b>' : '⚠️ <b>Жалобы на отзыв</b>',
    '',
    `<b>${esc(r.workKey)}</b>`,
    `Оценка: ${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}`,
    r.text ? `\n<i>${esc(r.text)}</i>\n` : '',
    `Автор: ${esc(r.authorName ?? 'без имени')}`,
    `Уникальных жалоб: ${r.reports}`,
    r.history.length
      ? `\nРанее: ${r.history.map((h) => `${h.action} (${h.reason})`).join('; ')}`
      : '',
  ].filter(Boolean)
  const kb = new InlineKeyboard()
    .text(
      r.status === 'hidden' ? '↩️ Вернуть' : '🙈 Скрыть',
      `rv:${r.status === 'hidden' ? 'restore' : 'hide'}:${r.id}`,
    )
    .text('🗑 Удалить', `rv:delete:${r.id}`)
    .row()
    .text('✅ Жалобы отклонить', `rv:dismiss:${r.id}`)
    .row()
    .text('🔇 Закрыть автору отзывы', `rs:reviews:${r.authorTg}`)
  return { text: lines.join('\n'), kb }
}

bot.command('moderation', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return
  const q = await moderationQueue()
  const head = [
    '🛡 <b>Разбор</b>',
    '',
    `Отзывы на разбор: ${q.reviews.length}`,
    `Книги на проверке: ${q.pendingBooksCount}${q.pendingBooksCount ? ' (/queue)' : ''}`,
    q.stuckNotices ? `⚠️ не доставлено уведомлений: ${q.stuckNotices}` : '',
    `Действующих ограничений: ${q.restrictions.length}`,
    `Заблокированных: ${q.banned.length}`,
    q.restrictions.length
      ? '\nОграничения:\n' +
        q.restrictions
          .map(
            (r) =>
              `• ${r.userTg}: ${SCOPE_TITLES[r.scope as keyof typeof SCOPE_TITLES] ?? r.scope}` +
              `${r.expiresAt ? ` до ${r.expiresAt.slice(0, 10)}` : ' бессрочно'} (${esc(r.reason)})`,
          )
          .join('\n')
      : '',
    q.banned.length
      ? '\nЗаблокированы:\n' +
        q.banned
          .map((b) => `• ${b.tgId} ${b.username ? '@' + esc(b.username) : ''}: ${esc(b.reason ?? '')}`)
          .join('\n')
      : '',
    q.recent.length
      ? '\nПоследние решения:\n' +
        q.recent
          .slice(0, 5)
          .map(
            (a) =>
              `• ${a.at.slice(0, 16).replace('T', ' ')} ${a.action} → ${a.targetUserTg ?? a.targetId ?? ''}`,
          )
          .join('\n')
      : '',
    '',
    'Ограничить: <code>/restrict tgId область дней причина</code>',
    'Снять: <code>/unrestrict tgId область причина</code>',
    'Блокировка: <code>/ban tgId причина</code> · <code>/unban tgId причина</code>',
    `Области: ${Object.keys(SCOPE_TITLES).join(', ')}`,
  ].filter(Boolean)
  await ctx.reply(head.join('\n'), { parse_mode: 'HTML' })

  for (const r of q.reviews.slice(0, 10)) {
    const card = reviewCard(r)
    await ctx.reply(card.text, { parse_mode: 'HTML', reply_markup: card.kb })
    await new Promise((res) => setTimeout(res, 40))
  }
})

/** Решение по отзыву кнопкой. Повторный тап отвечает честно, а не делает второе. */
bot.callbackQuery(/^rv:(hide|restore|delete|dismiss):(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Только для админов' })
  const decision = ctx.match![1] as 'hide' | 'restore' | 'delete' | 'dismiss'
  const reviewId = ctx.match![2]!
  // автора запоминаем ДО решения: удалённый отзыв уже не расскажет, чей он был
  const before = await prisma.review.findUnique({
    where: { id: reviewId },
    select: { authorTg: true },
  })
  const res = await decideReview({
    actorTg: BigInt(ctx.from.id),
    reviewId,
    decision,
    reason: 'решение модератора из очереди разбора',
  })
  if (!res.ok) {
    const texts: Record<string, string> = {
      not_found: 'Отзыв уже удалён',
      already_hidden: 'Уже скрыт',
      already_visible: 'Уже виден',
      no_reason: 'Нужна причина',
    }
    return ctx.answerCallbackQuery({ text: texts[res.code] ?? res.code })
  }
  await ctx.answerCallbackQuery({ text: 'Готово' })
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
  // письмо положено в очередь в той же транзакции, что и решение
  await flushNotices()
})

/** Быстрая кнопка «закрыть автору отзывы» прямо из карточки разбора. */
bot.callbackQuery(/^rs:(\w+):(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Только для админов' })
  const scope = ctx.match![1]!
  if (!isScope(scope)) return ctx.answerCallbackQuery({ text: 'Неизвестная область' })
  const targetTg = BigInt(ctx.match![2]!)
  const res = await restrictUser({
    actorTg: BigInt(ctx.from.id),
    targetTg,
    scope,
    reason: 'жалобы участников на отзывы',
    days: 30,
  })
  if (!res.ok) {
    const texts: Record<string, string> = {
      already_restricted: 'Уже ограничен',
      unknown_user: 'Человек не найден',
      self: 'Себя нельзя',
      no_reason: 'Нужна причина',
    }
    return ctx.answerCallbackQuery({ text: texts[res.code] ?? res.code })
  }
  await ctx.answerCallbackQuery({ text: 'Ограничение поставлено' })
  await flushNotices()
})

/**
 * Кого имел в виду админ: «@ник», числовой id или ответ на сообщение человека.
 *
 * Раньше команды принимали только числовой id, которого админу негде взять
 * (в интерфейсе Telegram их нет, в карточках проекта мы их намеренно не
 * показываем). Право было, а воспользоваться им было нельзя.
 */
async function whom(ctx: any, arg: string): Promise<bigint | null> {
  const replyTo = ctx.message?.reply_to_message?.from
  if (replyTo && !arg) return BigInt(replyTo.id)

  const res = await findPerson(arg)
  if (res.ok) return res.person.tgId

  const texts: Record<string, string> = {
    empty: 'Кого? Укажите @ник или числовой id, либо ответьте на сообщение человека.',
    not_found: `Не нашёл «${esc(arg)}». Человек должен хотя бы раз открыть бота — ник берётся из его профиля.`,
    known_but_no_tg:
      `«${esc(res.ok === false ? (res.name ?? arg) : arg)}» есть в справочнике библиотекарей, ` +
      'но бота ещё не открывал, поэтому в Telegram его не опознать. Попросите его написать боту.',
  }
  await ctx.reply(texts[res.ok === false ? res.code : 'not_found'], { parse_mode: 'HTML' })
  return null
}

/** `/restrict @ник|tgId область дней причина` (0 дней — бессрочно). */
bot.command('restrict', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return
  const [id, scope, days, ...rest] = (ctx.match?.toString() ?? '').trim().split(/\s+/)
  const reason = rest.join(' ')
  if (!id || !scope || !isScope(scope) || !reason) {
    return ctx.reply(
      `Формат: /restrict @ник область дней причина\n` +
        `(вместо @ника можно числовой id; 0 дней — бессрочно)\n` +
        `Области: ${Object.keys(SCOPE_TITLES).join(', ')}`,
    )
  }
  const targetTg = await whom(ctx, id)
  if (!targetTg) return
  const res = await restrictUser({
    actorTg: BigInt(ctx.from!.id),
    targetTg,
    scope,
    reason,
    days: Number(days) > 0 ? Number(days) : null,
  })
  if (!res.ok) return ctx.reply(`Не вышло: ${res.code}`)
  await flushNotices()
  await ctx.reply('Готово, человеку сообщили.')
})

/**
 * Снять карточку барахолки: `/market_remove <id> причина` или ответом на пост
 * в теме — тогда объявление находится по исходному сообщению.
 *
 * ⚠️ Само сообщение в Telegram команда НЕ удаляет: это внешняя необратимая
 * операция, которую не связать одной транзакцией с базой. Удаляет человек,
 * убедившись в результате.
 */
bot.command('market_remove', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return
  const args = (ctx.match?.toString() ?? '').trim()
  const reply = (ctx.message as any)?.reply_to_message
  // ответ на пост в теме барахолки: id брать не нужно, вся строка — причина
  const byReply = reply && BigInt(ctx.chat?.id ?? 0) === MAIN_CHAT_ID

  let id: string | undefined
  let reason: string
  if (byReply) {
    reason = args
  } else {
    const [first, ...rest] = args.split(/\s+/)
    id = first || undefined
    reason = rest.join(' ')
  }
  if (!reason || (!byReply && !id)) {
    return ctx.reply(
      'Формат: /market_remove <id> причина — или ответом на объявление в теме: /market_remove причина',
    )
  }

  const res = await removeMarketItem({
    actorTg: BigInt(ctx.from!.id),
    id,
    sourceMsgId: byReply ? reply.message_id : undefined,
    reason,
  })
  if (!res.ok) {
    const text: Record<string, string> = {
      no_reason: 'Нужна причина: её увидит автор.',
      not_found: 'Такого объявления нет. Ответьте на сам пост или дайте id.',
      already_removed: 'Это объявление уже снято.',
    }
    return ctx.reply(text[res.code] ?? res.code)
  }
  await flushNotices()
  await ctx.reply(
    `Снял «${esc(res.item.title)}» из барахолки. Автору сообщили.
` +
      'Само сообщение в теме не удалено — это делается вручную.',
    { parse_mode: 'HTML' },
  )
})

bot.command('unrestrict', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return
  const [id, scope, ...rest] = (ctx.match?.toString() ?? '').trim().split(/\s+/)
  const reason = rest.join(' ')
  if (!id || !scope || !isScope(scope) || !reason) {
    return ctx.reply('Формат: /unrestrict @ник область причина')
  }
  const targetTg = await whom(ctx, id)
  if (!targetTg) return
  const res = await unrestrictUser({
    actorTg: BigInt(ctx.from!.id),
    targetTg,
    scope,
    reason,
  })
  if (!res.ok) return ctx.reply(`Не вышло: ${res.code}`)
  await flushNotices()
  await ctx.reply('Ограничение снято, человеку сообщили.')
})

bot.command('ban', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return
  const [id, ...rest] = (ctx.match?.toString() ?? '').trim().split(/\s+/)
  const reason = rest.join(' ')
  if (!id || !reason) return ctx.reply('Формат: /ban @ник причина')
  const targetTg = await whom(ctx, id)
  if (!targetTg) return
  const res = await banUser({ actorTg: BigInt(ctx.from!.id), targetTg, reason })
  if (!res.ok) {
    const texts: Record<string, string> = {
      admin: 'Админа заблокировать нельзя',
      self: 'Себя заблокировать нельзя',
      already_banned: 'Уже заблокирован',
      unknown_user: 'Человек не найден',
      no_reason: 'Нужна причина',
    }
    return ctx.reply(texts[res.code] ?? res.code)
  }
  await flushNotices()
  await ctx.reply('Заблокирован, человеку сообщили. Свои данные он забрать по-прежнему может.')
})

bot.command('unban', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return
  const [id, ...rest] = (ctx.match?.toString() ?? '').trim().split(/\s+/)
  const reason = rest.join(' ')
  if (!id || !reason) return ctx.reply('Формат: /unban @ник причина')
  const targetTg = await whom(ctx, id)
  if (!targetTg) return
  const res = await unbanUser({ actorTg: BigInt(ctx.from!.id), targetTg, reason })
  if (!res.ok) return ctx.reply(`Не вышло: ${res.code}`)
  await flushNotices()
  await ctx.reply('Доступ восстановлен, человеку сообщили.')
})

/* ── кто есть кто ─────────────────────────────────────────── */

/**
 * Свой числовой id. Нужен всем: именно его просят прислать, когда человека
 * добавляют в администраторы (список админов задаётся в настройках сервера,
 * а не командой — иначе право раздавалось бы из переписки, см. ADMIN_GUIDE.md).
 */
bot.command('whoami', async (ctx) => {
  const me = ctx.from!
  await ctx.reply(
    [
      `Ваш числовой id: <code>${me.id}</code>`,
      me.username ? `Ник: @${esc(me.username)}` : 'Ника в профиле нет',
      isAdmin(me.id) ? '\n🛡 Вы администратор проекта.' : '',
    ]
      .filter(Boolean)
      .join('\n'),
    { parse_mode: 'HTML' },
  )
})

/** Карточка человека: `/who @ник`, `/who id` или ответом на его сообщение. */
bot.command('who', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return
  const arg = (ctx.match?.toString() ?? '').trim()
  const tgId = await whom(ctx, arg)
  if (!tgId) return

  const found = await findPerson(String(tgId))
  if (!found.ok) return ctx.reply('Не нашёл такого человека.')
  const card = await personCard(found.person)
  const p = card.person

  const lines = [
    `👤 <b>${esc(p.firstName ?? 'без имени')}</b>${p.username ? ` @${esc(p.username)}` : ''}`,
    `id: <code>${p.tgId}</code>`,
    p.city ? `Город: ${esc(p.city)}` : '',
    card.isAdmin ? '🛡 Администратор проекта' : '',
    p.accountStatus === 'banned'
      ? `⛔️ Заблокирован. Причина: ${esc(p.banReason ?? 'не указана')}`
      : '',
    '',
    card.librarian
      ? `📚 Библиотекарь «${esc(card.librarian.name)}», книг на полке: ${card.librarian.books}`
      : '📚 Своей полки нет',
    `Выдал книг: ${card.loansGiven} · взял: ${card.loansTaken} · отзывов: ${card.reviews}`,
  ]

  if (card.restrictions.length) {
    lines.push('', '<b>Действующие ограничения</b>')
    for (const r of card.restrictions) {
      lines.push(
        `• ${esc(r.title)} — ${esc(r.reason)}` +
          (r.until ? ` (до ${r.until.toISOString().slice(0, 10)})` : ' (бессрочно)'),
      )
    }
    lines.push('', `Снять: <code>/unrestrict @${esc(p.username ?? String(p.tgId))} область причина</code>`)
  } else {
    lines.push(
      '',
      'Ограничений нет.',
      `Поставить: <code>/restrict @${esc(p.username ?? String(p.tgId))} область дней причина</code>`,
    )
  }

  await ctx.reply(lines.filter((l) => l !== '').join('\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  })
})

/** Кто сейчас администратор: список берётся из настроек сервера. */
bot.command('admins', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return
  const rows = await prisma.user.findMany({
    where: { tgId: { in: env.adminIds } },
    select: { tgId: true, username: true, firstName: true },
  })
  const byId = new Map(rows.map((r) => [r.tgId.toString(), r]))
  const lines = env.adminIds.map((id) => {
    const u = byId.get(id.toString())
    const who = u ? `${esc(u.firstName ?? 'без имени')}${u.username ? ` @${esc(u.username)}` : ''}` : 'бота ещё не открывал'
    return `• <code>${id}</code> — ${who}`
  })
  await ctx.reply(
    [
      `🛡 <b>Администраторы</b> (${env.adminIds.length})`,
      '',
      ...lines,
      '',
      'Список задан в настройках сервера (ADMIN_IDS), командой его не изменить.',
      'Как добавить человека — в руководстве администратора (docs/ADMIN_GUIDE.md).',
    ].join('\n'),
    { parse_mode: 'HTML' },
  )
})

/** Короткая сводка проекта: что происходит и на что смотреть. */
bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return
  const s = await projectStats()
  const attention = [
    s.pendingBooks ? `книг на проверке ${s.pendingBooks} (/queue)` : '',
    s.hiddenReviews ? `скрытых отзывов ${s.hiddenReviews} (/moderation)` : '',
    s.overdueLoans ? `просроченных выдач ${s.overdueLoans}` : '',
    s.stuckNotices ? `не доставлено писем ${s.stuckNotices}` : '',
  ].filter(Boolean)

  await ctx.reply(
    [
      '📊 <b>Проект сейчас</b>',
      '',
      `Книг в каталоге: ${s.books} (за неделю прибавилось ${s.newBooksWeek})`,
      `Библиотекарей: ${s.librarians}`,
      `Книг на руках: ${s.activeLoans}, ждут в очереди: ${s.waiting}`,
      `Оценок и отзывов: ${s.reviews}`,
      `Предстоящих встреч: ${s.events} · объявлений в барахолке: ${s.market}`,
      `Ограничений действует: ${s.restrictions} · заблокировано: ${s.banned}`,
      '',
      attention.length ? `⚠️ <b>Требует внимания:</b> ${attention.join(', ')}` : '✅ Разбирать нечего.',
    ].join('\n'),
    { parse_mode: 'HTML' },
  )
})

/* ── встречи ──────────────────────────────────────────────── */

/** Прошедшие встречи с их id — чтобы было что снимать командой. */
bot.command('events_past', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return
  const rows = await listPastEvents()
  if (!rows.length) return ctx.reply('Прошедших встреч за последние 60 дней нет.')
  const lines = rows.slice(0, 20).map(
    (e) =>
      `• <b>${esc(e.title)}</b> — ${esc(e.city)}, ${e.startsAt.toISOString().slice(0, 16).replace('T', ' ')}\n` +
      `  убрать: <code>/event_remove ${e.id}</code>`,
  )
  await ctx.reply(
    [
      `📅 <b>Прошедшие встречи</b> (${rows.length})`,
      '',
      ...lines,
      '',
      'То же самое свайпом влево — в приложении, экран «Встречи».',
    ].join('\n'),
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
  )
})

/** Убрать прошедшую встречу. Предстоящую эта команда не снимает — см. events.ts. */
bot.command('event_remove', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return
  const [id, ...rest] = (ctx.match?.toString() ?? '').trim().split(/\s+/)
  if (!id) return ctx.reply('Формат: /event_remove <id> [причина]. Список id — /events_past')
  const res = await removeEvent({
    actorTg: BigInt(ctx.from!.id),
    id,
    reason: rest.join(' ') || undefined,
  })
  if (!res.ok) {
    const texts: Record<string, string> = {
      not_found: 'Такой встречи нет. Список id — /events_past',
      not_past: 'Эта встреча ещё не прошла. Предстоящие не убираем: их уже видят люди.',
      already_removed: 'Эта встреча уже убрана.',
    }
    return ctx.reply(texts[res.code] ?? res.code)
  }
  await ctx.reply(`Убрал «${esc(res.event.title)}» из афиши.`, { parse_mode: 'HTML' })
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
  // варшавское время с учётом CET/CEST, не захардкоженный +02:00
  const m = when.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/)
  const startsAt = m ? warsawTime(m[1], m[2]) : new Date(NaN)
  if (Number.isNaN(startsAt.getTime())) return ctx.reply('Не понял дату. Формат: 2026-08-01 18:30')
  const event = await prisma.event.create({
    data: { city, title, startsAt, place: place || null, createdBy: BigInt(ctx.from!.id) },
  })
  await ctx.reply(`Встреча «${title}» добавлена, рассылаю анонс.`)
  await notifyNewEvent(event)
})

/* ── антиспам ─────────────────────────────────────────────── */

/**
 * Проверка каждого сообщения чата и лички на рекламу.
 *
 * Что делает и, главное, чего НЕ делает:
 *  - явный спам удаляется, но копия текста уходит админам. Молча пропавшее
 *    сообщение выглядит как поломка чата, и разобрать жалобу «у меня удалили»
 *    было бы нечем;
 *  - спорное НЕ трогается вовсе: приходит карточка с кнопками, решает человек.
 *    Ошибка машины здесь необратима — удалённое в Telegram не вернуть;
 *  - автор НЕ наказывается автоматически. Ограничение ставит админ кнопкой:
 *    счёт баллов годится, чтобы убрать сообщение, но не чтобы закрыть человеку
 *    участие в проекте.
 *
 * Возвращает true, если сообщение дальше обрабатывать не нужно.
 */
async function stoppedBySpam(ctx: any, text: string): Promise<boolean> {
  if (env.antispamOff) return false
  const from = ctx.from
  if (!from || from.is_bot) return false
  // свои решения админов и их объявления не проверяем вовсе
  if (isAdmin(from.id)) return false

  const inMainChat = BigInt(ctx.chat?.id ?? 0) === MAIN_CHAT_ID
  const isPrivate = ctx.chat?.type === 'private'
  if (!inMainChat && !isPrivate) return false

  const tgId = BigInt(from.id)
  const [user, librarian] = await Promise.all([
    prisma.user.findUnique({ where: { tgId }, select: { createdAt: true } }),
    prisma.librarian.findFirst({ where: { tgId, mergedIntoId: null }, select: { id: true } }),
  ])

  const verdict = checkSpam(text, {
    marketTopic: isMarketTopic(ctx),
    known: Boolean(librarian),
    firstSeen: !user,
  })
  if (verdict.level === 'clean') return false

  // в личке бот никого не удаляет: там человек пишет ему, а не сообществу.
  // Просто не пускаем рекламу в платный ИИ-подбор
  if (isPrivate) {
    if (verdict.level !== 'spam') return false
    await ctx.reply(
      'Похоже на рекламу, отвечать на такое не буду. Если это ошибка, напишите администраторам.',
    )
    return true
  }

  const who =
    `${esc(from.first_name ?? 'без имени')}${from.username ? ` @${esc(from.username)}` : ''}` +
    ` (id <code>${from.id}</code>)`
  const quote = esc(text.slice(0, 500)) + (text.length > 500 ? '…' : '')
  const msgId = ctx.message.message_id

  if (verdict.level === 'spam') {
    const deleted = await ctx.api
      .deleteMessage(ctx.chat.id, msgId)
      .then(() => true)
      .catch((e: any) => {
        console.warn('[antispam] удалить не вышло:', e?.description ?? e?.message ?? e)
        return false
      })

    await tellAdmins(
      [
        deleted ? '🗑 <b>Удалил рекламу</b>' : '⚠️ <b>Реклама, удалить не смог</b>',
        `Автор: ${who}`,
        `Причина: ${esc(verdict.reason)} (${verdict.score} баллов)`,
        '',
        `<i>${quote}</i>`,
      ].join('\n'),
      new InlineKeyboard()
        .text('↩️ Это не спам', `sp:false:${from.id}`)
        .row()
        .text('🔇 Ограничить автора', `rs:all:${from.id}`),
    )

    await logModerationAction({
      // решение приняла машина: в журнале это должно быть видно, поэтому
      // автора нет, а не «нулевой админ»
      actorTg: null,
      targetUserTg: tgId,
      targetType: 'message',
      action: 'spam_delete',
      reason: verdict.reason,
      meta: { score: verdict.score, chatId: String(ctx.chat.id), messageId: msgId },
    })

    // автору говорим, что случилось: если это ошибка, он придёт к админам,
    // а не решит, что чат сломался. Написать можем не всегда — это нормально
    await bot.api
      .sendMessage(
        String(from.id),
        'Ваше сообщение в чате проекта удалено как реклама.\n' +
          `Что сработало: ${verdict.reason}.\n` +
          'Если это ошибка, напишите администраторам проекта.',
      )
      .catch(() => {})
    return true
  }

  // спорное: сообщение остаётся, решает человек
  await tellAdmins(
    [
      '⚠️ <b>Похоже на рекламу, не трогал</b>',
      `Автор: ${who}`,
      `Причина: ${esc(verdict.reason)} (${verdict.score} баллов)`,
      '',
      `<i>${quote}</i>`,
    ].join('\n'),
    new InlineKeyboard()
      .text('🗑 Удалить', `sp:del:${ctx.chat.id}:${msgId}`)
      .text('✅ Оставить', `sp:keep:${from.id}`),
  )
  return false
}

/** Удалить спорное сообщение по кнопке из карточки. */
bot.callbackQuery(/^sp:del:(-?\d+):(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Только для админов' })
  const [, chatId, msgId] = ctx.match
  const ok = await ctx.api
    .deleteMessage(Number(chatId), Number(msgId))
    .then(() => true)
    .catch(() => false)
  await logModerationAction({
    actorTg: BigInt(ctx.from.id),
    targetType: 'message',
    action: 'spam_delete',
    reason: 'решение админа по карточке антиспама',
    meta: { chatId, messageId: Number(msgId) },
  })
  await ctx.answerCallbackQuery({ text: ok ? 'Удалил' : 'Не вышло: сообщения уже нет' })
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
})

/**
 * «Это не спам» и «Оставить» ничего не отменяют технически (удалённое в
 * Telegram не вернуть), но записывают ошибку в журнал: по этим записям и
 * настраиваются пороги, иначе тюнинг был бы вслепую.
 */
bot.callbackQuery(/^sp:(false|keep):(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Только для админов' })
  const [, kind, authorId] = ctx.match
  await logModerationAction({
    actorTg: BigInt(ctx.from.id),
    targetUserTg: BigInt(authorId),
    targetType: 'message',
    action: 'spam_false_positive',
    reason: kind === 'false' ? 'админ: это не спам' : 'админ: оставить сообщение',
  })
  await ctx.answerCallbackQuery({ text: 'Записал, спасибо — по этим отметкам правим пороги' })
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
})

/* ── входящие сообщения: темы чата, фото книг, запрос к ИИ ── */

bot.on('message:photo', async (ctx) => {
  // афиша и барахолка обычно приходят картинкой с подписью
  const caption = ctx.message.caption?.trim()
  // спам приходит картинкой не реже, чем текстом: проверяем подпись до разбора,
  // иначе реклама успела бы стать карточкой барахолки
  if (caption && (await stoppedBySpam(ctx, caption))) return
  if (isEventsTopic(ctx)) return caption ? handleAnnouncement(ctx, caption) : undefined
  if (isMarketTopic(ctx)) return caption ? handleMarketPost(ctx, caption) : undefined
  // фото в личке считаем обложкой книги
  if (ctx.chat.type !== 'private') return
  if (await stoppedByRules(ctx, 'add_books')) return
  // альбом (несколько фото разом) — добавляем пачкой
  if (ctx.message.media_group_id) return bufferAlbumPhoto(ctx)
  await handleBookPhoto(ctx)
})

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim()
  if (text.startsWith('/')) return

  // антиспам идёт ПЕРВЫМ: реклама не должна ни превратиться в карточку
  // барахолки, ни уехать в платный ИИ-подбор
  if (await stoppedBySpam(ctx, text)) return

  if (isEventsTopic(ctx)) return handleAnnouncement(ctx, text)
  if (isMarketTopic(ctx)) return handleMarketPost(ctx, text)
  if (ctx.chat.type !== 'private') return
  // человек только что поставил оценку и пишет пару слов о книге — это не
  // вопрос к ИИ-подбору, куда уходит любой другой текст
  if (await handleReviewText(ctx, text)) return
  // ISBN одной строкой — это «поставь вот эту книгу», а не вопрос к ИИ-подбору,
  // куда такое сообщение уходило раньше
  if (looksLikeIsbn(text)) return handleIsbnMessage(ctx, text)
  // список ISBN построчно без /import: берём, только если ВСЕ строки — ISBN,
  // иначе многострочный вопрос к ИИ («хочу лёгкое\nи на польском») уедет не туда
  const lines = text.split('\n').map((l: string) => l.trim()).filter(Boolean)
  if (lines.length > 1 && lines.every(looksLikeIsbn)) return handleListImport(ctx, text)
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
async function tellAdmins(text: string, keyboard?: InlineKeyboard) {
  for (const id of env.adminIds) {
    await bot.api
      .sendMessage(String(id), text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: keyboard } : {}),
      })
      .catch(() => {})
  }
}

/** null — ещё не читали ни память, ни базу; иначе последнее известное состояние. */
let notionTokenOk: boolean | null = null
const NOTION_OK_KEY = 'notion:tokenOk'

/**
 * NOTION_TOKEN_V2 — cookie живого аккаунта: живёт около года и слетает молча
 * (логаут, смена пароля). Раньше об этом узнавали по накопившимся карточкам
 * `pending`, то есть сильно позже. Проверяем сами и говорим админам при
 * изменении состояния — и когда сломалось, и когда починили. Последнее
 * состояние лежит в базе: иначе каждый деплой обнулял память, и админам
 * повторно прилетал один и тот же алерт «Notion не пускает».
 */
export async function checkNotionToken() {
  if (!notionWriteEnabled()) return
  if (notionTokenOk === null) {
    const row = await prisma.syncState.findUnique({ where: { key: NOTION_OK_KEY } }).catch(() => null)
    if (row) notionTokenOk = row.value === '1'
  }
  const ok = await whoAmI()
    .then(() => true)
    .catch((e) => {
      console.error('[notion] токен не отвечает:', e?.message ?? e)
      return false
    })

  if (notionTokenOk === ok) return
  const first = notionTokenOk === null
  notionTokenOk = ok
  await prisma.syncState
    .upsert({
      where: { key: NOTION_OK_KEY },
      create: { key: NOTION_OK_KEY, value: ok ? '1' : '0' },
      update: { value: ok ? '1' : '0' },
    })
    .catch(() => {})

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

/**
 * Личное меню админа: те же команды, что у всех, плюс админские.
 *
 * Telegram позволяет задать набор команд для конкретного чата
 * (`BotCommandScopeChat`), и это единственный способ показать админские команды
 * в подсказке — общий список видят все, а туда их класть нельзя.
 * Раньше админ не видел своих команд нигде и знал только то, что ему сказали.
 */
const ADMIN_MENU = [
  { command: 'stats', description: '🛡 Что происходит в проекте' },
  { command: 'moderation', description: '🛡 Разбор: отзывы, книги, люди' },
  { command: 'queue', description: '🛡 Книги на проверке' },
  { command: 'who', description: '🛡 Карточка человека по @нику' },
  { command: 'whoami', description: '🛡 Свой числовой id' },
  { command: 'admins', description: '🛡 Кто сейчас администратор' },
  { command: 'events_past', description: '🛡 Убрать прошедшую встречу' },
  { command: 'addevent', description: '🛡 Завести встречу' },
  { command: 'onbehalf', description: '🛡 Добавлять книги за библиотекаря' },
  { command: 'sync', description: '🛡 Синхронизировать с Notion' },
  { command: 'topics', description: '🛡 Видит ли бот чат проекта' },
]

export async function setupBotCommands() {
  const me = await bot.api.getMe().catch(() => null)
  if (me?.username) BOT_USERNAME = me.username

  const common = [
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
    { command: 'club', description: 'Книжный клуб «Книжная Клумба»' },
    { command: 'import', description: 'Добавить книги пачкой (альбом или список)' },
    { command: 'donate', description: 'Поддержать проект звёздами' },
    { command: 'help', description: 'Помощь' },
  ]
  await bot.api.setMyCommands(common)

  // у каждого админа своё меню; сбой одного не должен ронять запуск бота
  for (const id of env.adminIds) {
    await bot.api
      .setMyCommands([...common, ...ADMIN_MENU], { scope: { type: 'chat', chat_id: Number(id) } })
      .catch((e: any) => console.warn(`[bot] меню админа ${id} не поставилось:`, e?.message ?? e))
  }

  // постоянная кнопка Mini App слева от поля ввода
  if (webAppUrl()) {
    await bot.api.setChatMenuButton({
      menu_button: { type: 'web_app', text: 'Библиотека', web_app: { url: webAppUrl() } },
    })
  }
}
