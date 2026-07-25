import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import { webhookCallback } from 'grammy'
import { env, botDisabled } from './env.js'
import { prisma } from './db.js'
import { registerRoutes } from './routes.js'
import { bot, checkNotionToken, remindOverdueLoans, setupBotCommands } from './bot.js'
import { startSyncLoop } from './sync.js'
import { seedCityGroups } from './seed.js'
import { housekeepImgCache } from './imgcache.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const webDist = path.resolve(here, '../../web/dist')

// фото обложек приходят как dataURL в теле запроса — стандартного мегабайта мало
const app = Fastify({ logger: { level: 'info' }, bodyLimit: 12 * 1024 * 1024 })

/**
 * CORS: только собственный origin. `origin: true` отражал ЛЮБОЙ Origin, то есть
 * скрипт с чужого сайта мог читать наши ответы из браузера посетителя. Mini App
 * отдаётся с того же origin, что и API (а в dev у vite стоит proxy на /api),
 * поэтому кросс-доменные запросы не нужны никому из своих.
 */
const ownOrigin = (() => {
  try {
    return env.publicUrl ? new URL(env.publicUrl).origin : null
  } catch {
    return null
  }
})()
await app.register(cors, { origin: ownOrigin ? [ownOrigin] : false })

/**
 * Единая политика кэша (заголовки плагина статики отключены ниже, ставим сами):
 * - /api/* → no-store (данные меняются; кроме ручек со своим Cache-Control,
 *   например обложки — они по хэшу и immutable);
 * - хэшированные ассеты /assets/* → кэш навсегда;
 * - index.html и всё остальное (SPA) → no-store, чтобы тянуть свежие ассеты;
 * - иллюстрации /il/* (имена не хэшированы) → умеренный кэш на сутки.
 */
app.addHook('onSend', (req, reply, payload, done) => {
  const url = req.url.split('?')[0]
  if (url.startsWith('/api/')) {
    if (!reply.getHeader('cache-control')) reply.header('Cache-Control', 'no-store')
  } else if (url.startsWith('/assets/')) {
    reply.header('Cache-Control', 'public, max-age=31536000, immutable')
  } else if (url.startsWith('/il/')) {
    reply.header('Cache-Control', 'public, max-age=86400')
  } else {
    reply.header('Cache-Control', 'no-store')
  }
  done(null, payload)
})

await registerRoutes(app)

// Mini App раздаём тем же сервером; кэш-заголовки ставим сами в onSend выше
await app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: false, cacheControl: false })
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' })
  return reply.sendFile('index.html')
})

const WEBHOOK_PATH = '/tg/webhook'
if (env.botMode === 'webhook' && !botDisabled) {
  // ⚠️ Дефолт grammY — ответить 500 через 10 с. ИИ-подбор и распознавание фото
  // длятся дольше, Telegram считал апдейт недоставленным и слал его снова и снова,
  // а бот на каждый повтор отвечал в чат. Отдаём 200 сразу, работа идёт дальше.
  app.post(
    WEBHOOK_PATH,
    webhookCallback(bot, 'fastify', {
      onTimeout: 'return',
      timeoutMilliseconds: 8_000,
      // без совпадения секрета апдейт не наш — grammY ответит 401
      secretToken: env.webhookSecret,
    }),
  )
}

await seedCityGroups()
if (!botDisabled) {
  // недоступность Telegram не должна ронять веб-часть
  await setupBotCommands().catch((e) =>
    app.log.warn(`не удалось установить команды бота: ${e?.message ?? e}`),
  )
}

await app.listen({ port: env.port, host: env.host })
app.log.info(`Mini App: ${env.publicUrl || `http://localhost:${env.port}`}`)

if (botDisabled) {
  app.log.warn('DISABLE_BOT=1 — бот не запущен, работает только API и Mini App')
} else if (env.botMode === 'webhook') {
  if (!env.publicUrl) throw new Error('Для BOT_MODE=webhook нужен PUBLIC_URL')
  await bot.api.setWebhook(`${env.publicUrl}${WEBHOOK_PATH}`, {
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    // очередь повторов, накопленная за простой, при старте не нужна:
    // это ровно те апдейты, на которые бот уже отвечал
    drop_pending_updates: true,
    secret_token: env.webhookSecret,
  })
  app.log.info(`webhook: ${env.publicUrl}${WEBHOOK_PATH}`)
} else {
  /**
   * Предохранитель: запуск с BOT_MODE=polling делает deleteWebhook и молча
   * забирает апдейты у прода — бот в Telegram один, и «локальный» запуск
   * с рабочим токеном означает, что живой бот замолкает, пока не заметят.
   * Поэтому: увидели чужой вебхук — не трогаем его и не поднимаем polling.
   */
  const hook = await bot.api.getWebhookInfo().catch(() => null)
  const foreign = hook?.url && hook.url !== `${env.publicUrl}${WEBHOOK_PATH}`
  if (foreign && process.env.ALLOW_STEAL_WEBHOOK !== '1') {
    throw new Error(
      `У этого бота уже настроен вебхук ${hook!.url} — polling отобрал бы у него ` +
        'апдейты. Заведите для разработки отдельного бота у @BotFather, ' +
        'или поднимите только веб-часть (DISABLE_BOT=1). ' +
        'Осознанно перехватить: ALLOW_STEAL_WEBHOOK=1.',
    )
  }
  await bot.api.deleteWebhook().catch(() => {})
  // 409 «terminated by other getUpdates» приходит, когда где-то запущен второй
  // экземпляр — падать из-за этого веб-часть не должна
  bot
    .start({ allowed_updates: ['message', 'callback_query', 'my_chat_member'] })
    .catch((e) => app.log.error(`polling остановлен: ${e?.message ?? e}`))
  app.log.info('bot: long polling')
}

startSyncLoop()

// диск под превью обложек иначе растёт бесконечно (см. imgcache.ts) — не зависит от бота
const imgHousekeep = () =>
  housekeepImgCache()
    .then((r) => {
      if (r.removed) {
        app.log.info(`[imgcache] чистка: ${r.removed}/${r.scanned} файлов, освобождено ${(r.freedBytes / 1024 / 1024).toFixed(1)} МБ`)
      }
    })
    .catch((e) => app.log.error(`[imgcache] ${e?.message ?? e}`))
const imgHousekeepTimer = setInterval(imgHousekeep, 6 * 3600_000)
imgHousekeepTimer.unref?.()

// раз в сутки напоминаем про книги, которые загостились у читателей
if (!botDisabled) {
  const loansTimer = setInterval(
    () => remindOverdueLoans().catch((e) => app.log.error(`[loans] ${e?.message ?? e}`)),
    24 * 3600_000,
  )
  loansTimer.unref?.()

  // cookie Notion слетает молча — узнаём об этом сами, а не по жалобам
  const notionCheck = () =>
    checkNotionToken().catch((e) => app.log.error(`[notion] ${e?.message ?? e}`))
  void notionCheck()
  const notionTimer = setInterval(notionCheck, 24 * 3600_000)
  notionTimer.unref?.()
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    app.log.info('останавливаюсь…')
    await bot.stop().catch(() => {})
    await app.close()
    await prisma.$disconnect()
    process.exit(0)
  })
}
