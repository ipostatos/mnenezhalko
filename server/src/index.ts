import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import { webhookCallback } from 'grammy'
import { env } from './env.js'
import { prisma } from './db.js'
import { registerRoutes } from './routes.js'
import { bot, setupBotCommands } from './bot.js'
import { startSyncLoop } from './sync.js'
import { seedCityGroups } from './seed.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const webDist = path.resolve(here, '../../web/dist')

// фото обложек приходят как dataURL в теле запроса — стандартного мегабайта мало
const app = Fastify({ logger: { level: 'info' }, bodyLimit: 12 * 1024 * 1024 })

await app.register(cors, { origin: true })
await registerRoutes(app)

// Mini App раздаём тем же сервером
await app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: false })
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' })
  return reply.sendFile('index.html')
})

// DISABLE_BOT=1 — поднять только API/Mini App, не отбирая long polling у прода
const botDisabled = process.env.DISABLE_BOT === '1'

const WEBHOOK_PATH = '/tg/webhook'
if (env.botMode === 'webhook' && !botDisabled) {
  app.post(WEBHOOK_PATH, webhookCallback(bot, 'fastify'))
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
    allowed_updates: ['message', 'callback_query'],
  })
  app.log.info(`webhook: ${env.publicUrl}${WEBHOOK_PATH}`)
} else {
  await bot.api.deleteWebhook().catch(() => {})
  // 409 «terminated by other getUpdates» приходит, когда где-то запущен второй
  // экземпляр — падать из-за этого веб-часть не должна
  bot
    .start({ allowed_updates: ['message', 'callback_query'] })
    .catch((e) => app.log.error(`polling остановлен: ${e?.message ?? e}`))
  app.log.info('bot: long polling')
}

startSyncLoop()

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    app.log.info('останавливаюсь…')
    await bot.stop().catch(() => {})
    await app.close()
    await prisma.$disconnect()
    process.exit(0)
  })
}
