/**
 * Обработчики бота на живой цепочке grammY (аудит 14.08.2026).
 *
 * До сих пор бот (3100 строк) не был покрыт ни одним тестом: проверялись только
 * чистые функции, которые он зовёт. Аудит нашёл там ровно те дефекты, которые
 * такими тестами и ловятся — порядок middleware и пропущенный тип сообщения.
 *
 * Сети здесь нет: вызовы Telegram перехватываются трансформером `bot.api`,
 * апдейты скармливаются напрямую через `bot.handleUpdate`.
 *
 * Запуск: npm run test -w server
 */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `bot-handlers-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.BOT_TOKEN = '123456:test-token'
process.env.ADMIN_IDS = '999001'
process.env.ANTHROPIC_API_KEY = '' // ИИ-подбор выключен: сеть в тестах не нужна

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { bot } = await import('./bot.js')
const { MAIN_CHAT_ID } = await import('./seed.js')

/** Перехваченные вызовы Telegram: сеть не дёргаем, ответы подставляем сами. */
let calls: { method: string; payload: any }[] = []

bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload })
  return { ok: true, result: true } as any
})

// grammY требует знать, кто он: иначе handleUpdate ждёт getMe по сети.
// Приведение типа намеренное: Bot API дописывает в getMe новые поля, и тест не
// должен краснеть от каждой такой правки — обработчикам нужны id и username.
bot.botInfo = {
  id: 1,
  is_bot: true,
  first_name: 'test',
  username: 'mnenezhalkobot',
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
} as unknown as typeof bot.botInfo

const SPAMMER = 555777n
const SPAM_TEXT = 'Заработок на крипте от 500$ в день! Пиши в лс 💰💰💰 t.me/+abc123'

let updateId = 1
const groupUpdate = (message: Record<string, unknown>) => ({
  update_id: updateId++,
  message: {
    message_id: updateId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: Number(MAIN_CHAT_ID), type: 'supergroup', title: 'Чат проекта' },
    from: { id: Number(SPAMMER), is_bot: false, first_name: 'Спамер' },
    ...message,
  },
})

beforeEach(async () => {
  calls = []
  await prisma.user.deleteMany()
})

after(async () => {
  await prisma.$disconnect()
  try {
    unlinkSync(DB_FILE)
  } catch {}
})

const deleted = () => calls.filter((c) => c.method === 'deleteMessage')

test('реклама в общем чате удаляется, админам уходит карточка', async () => {
  await bot.handleUpdate(groupUpdate({ text: SPAM_TEXT }) as any)
  assert.equal(deleted().length, 1, 'спам должен быть удалён')
  assert.ok(
    calls.some((c) => c.method === 'sendMessage' && String(c.payload.chat_id) === '999001'),
    'админам должна уйти карточка о решении',
  )
})

test('реклама с ведущей «/» тоже удаляется (аудит 14.08.2026)', async () => {
  // Найдено аудитом: отсечение команд стояло РАНЬШЕ антиспама, поэтому
  // «/ заработок…» проходило в чат нетронутым. Для участников это обычный
  // текст, а не команда бота.
  await bot.handleUpdate(groupUpdate({ text: `/ ${SPAM_TEXT}` }) as any)
  assert.equal(deleted().length, 1, 'ведущая косая черта не должна быть щитом от антиспама')
})

test('реклама подписью к видео удаляется (проверялась только подпись фото)', async () => {
  await bot.handleUpdate(
    groupUpdate({
      caption: SPAM_TEXT,
      video: { file_id: 'v1', file_unique_id: 'u1', width: 10, height: 10, duration: 1 },
    }) as any,
  )
  assert.equal(deleted().length, 1, 'подпись к видео проверяется так же, как подпись к фото')
})

test('реклама подписью к документу удаляется', async () => {
  await bot.handleUpdate(
    groupUpdate({
      caption: SPAM_TEXT,
      document: { file_id: 'd1', file_unique_id: 'u2', file_name: 'x.pdf' },
    }) as any,
  )
  assert.equal(deleted().length, 1)
})

test('обычное сообщение участника не трогаем', async () => {
  await bot.handleUpdate(groupUpdate({ text: 'Дочитала «Мастера и Маргариту», отдам почитать' }) as any)
  assert.equal(deleted().length, 0, 'живой разговор удалять нельзя')
})

test('команда в общем чате остаётся командой, а не поводом для удаления', async () => {
  await bot.handleUpdate(groupUpdate({ text: '/help' }) as any)
  assert.equal(deleted().length, 0)
})
