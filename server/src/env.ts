import crypto from 'node:crypto'
import 'dotenv/config'

function req(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Не задана переменная окружения ${name}`)
  return v
}

/** DISABLE_BOT=1 — поднимаем только API и Mini App, бот не нужен. */
export const botDisabled = process.env.DISABLE_BOT === '1'

// без бота токен не нужен: локально так удобно править веб-часть, не держа
// на машине рабочий токен (подпись initData при этом, конечно, не проверяется)
const botToken = botDisabled ? (process.env.BOT_TOKEN ?? '') : req('BOT_TOKEN')

/**
 * Секрет вебхука: Telegram шлёт его в заголовке X-Telegram-Bot-Api-Secret-Token,
 * и без совпадения апдейт отбрасывается. Иначе кто угодно, зная адрес, отправит
 * поддельный апдейт от имени любого человека — вплоть до админских команд.
 * Если в окружении не задан, выводим из токена бота: значение стабильное между
 * рестартами, невыводимое снаружи и не требует ручной правки .env.
 */
const webhookSecret =
  process.env.WEBHOOK_SECRET ||
  crypto.createHash('sha256').update(`${botToken}:webhook`).digest('hex')

/**
 * Что за сборка работает. `RELEASE_SHA` подставляет выкладка (release.sh), локально
 * его нет — тогда честно отдаём 'dev'. По этому полю проверка живости убеждается,
 * что ответил ИМЕННО новый процесс, а не переживший рестарт прежний.
 */
const releaseSha = process.env.RELEASE_SHA || 'dev'
// номер версии подставляет та же выкладка из package.json. Держать здесь копию
// строки нельзя: она молча расходится с манифестом на каждом релизе (так и вышло
// с 0.2.0-beta.1). Нет переменной — значит это не релиз, а локальный запуск.
const version = process.env.RELEASE_VERSION || 'dev'

/**
 * Токен внешнего монитора. Он стучится в прод снаружи (расписание GitHub
 * Actions) и после удачного обхода отмечается через `POST /api/monitor/ping`.
 * По этой отметке ВНУТРЕННЯЯ проверка понимает, что монитор жив: иначе
 * выключенное расписание выглядело бы ровно как «снаружи всё хорошо».
 * Пусто — ручка отключена целиком (404), отметки никто не ждёт.
 */
const monitorToken = process.env.MONITOR_PING_TOKEN || ''

export const env = {
  releaseSha,
  version,
  botToken,
  webhookSecret,
  monitorToken,
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
    /** предохранитель массовой деактивации (см. deactivationGuard в sync.ts) */
    guardMinVolume: Number(process.env.NOTION_SYNC_GUARD_MIN || 20),
    guardPercent: Number(process.env.NOTION_SYNC_GUARD_PCT || 0.15),
  },

  /** cookie token_v2 служебного аккаунта Notion — без него запись выключена */
  notionToken: process.env.NOTION_TOKEN_V2 || '',
  /** id пользователя Notion; нужен, если у аккаунта несколько пространств */
  notionUserId: process.env.NOTION_USER_ID || '',

  /**
   * Ключ Google Books (бесплатный, из Google Cloud Console). Без него сервис
   * отдаёт 429 по общей анонимной квоте, то есть русские издания по ISBN
   * практически не находятся — см. порядок источников в isbn.ts.
   */
  googleBooksKey: process.env.GOOGLE_BOOKS_KEY || '',

  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',

  /**
   * Секрет для журнала исполненных удалений (см. mydata.ts::tgHash).
   *
   * Telegram id — короткое предсказуемое число: обычный sha256 от него
   * перебирается за секунды, то есть «в журнале только хэш» ничего не защищало
   * бы. Поэтому HMAC, и ключ у него ОТДЕЛЬНЫЙ: журнал должен оставаться
   * нечитаемым, даже если утёк токен бота.
   *
   * По умолчанию выводится из токена бота, чтобы установка работала без
   * дополнительной настройки; на проде задаётся явно.
   * ⚠️ Смена ключа обесценивает уже накопленный журнал: старые записи перестают
   * совпадать с кем-либо, и повторное применение удалений после восстановления
   * копии по ним больше не сработает. Менять только осознанно.
   */
  deletionPepper:
    process.env.PRIVACY_DELETION_PEPPER ||
    crypto.createHash('sha256').update(`${botToken}:deletion-journal`).digest('hex'),

  adminIds: (process.env.ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => BigInt(s)),

  mainChatUrl: process.env.MAIN_CHAT_URL || 'https://t.me/+hlRk_HGIDcE4M2Vi',

  /**
   * Книжный клуб «Книжная Клумба МнеНеЖалко» — чат клуба в Telegram.
   * Раньше здесь стояла страница в Notion; клуб живёт в чате (user, 29.07.2026).
   */
  clubUrl: process.env.CLUB_URL || 'https://t.me/bookclub_mnzh',

  /**
   * Модерация книг: при MODERATION_ON=1 книга обычного пользователя уходит на
   * проверку (reviewStatus=pending) и не попадает в каталог/Notion до одобрения.
   * Админы (ADMIN_IDS) всегда autoApprove. По умолчанию выкл — поведение как было.
   */
  moderation: process.env.MODERATION_ON === '1',
}

export const isAdmin = (tgId: bigint | number) =>
  env.adminIds.some((id) => id === BigInt(tgId))
