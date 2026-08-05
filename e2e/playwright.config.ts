import { defineConfig, devices } from '@playwright/test'

/**
 * Сквозные проверки Mini App: настоящий сервер, настоящая база, собранный
 * фронт. До этого роботом проверялись только сервер и отдельные компоненты, а
 * весь путь человека (добавил книгу → выдал → вернул → оценил) держался на
 * ручных прогонах.
 *
 * Telegram здесь не участвует: подпись initData подделывается тестовым токеном
 * бота (см. fixtures.ts), объект `window.Telegram.WebApp` подставляется до
 * загрузки приложения.
 *
 * Запуск: npm run test:e2e (перед этим собирается web).
 */
const PORT = Number(process.env.E2E_PORT || 4399)

export default defineConfig({
  testDir: './tests',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices['Desktop Chrome'],
    // люди живут на телефоне: ширина как у iPhone 12/13. Движок при этом
    // chromium, а не webkit — иначе CI пришлось бы качать второй браузер
    viewport: { width: 390, height: 844 },
    trace: process.env.CI ? 'retain-on-failure' : 'off',
  },
  // сценарии делят одну базу и одного человека — параллелить их нельзя
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  webServer: {
    command: 'node --import tsx ./start-server.mts',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'test',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      // бот не поднимается, но токен нужен: им подписывается initData
      DISABLE_BOT: '1',
      BOT_TOKEN: process.env.E2E_BOT_TOKEN || '424242:e2e-test-token',
      // путь относительно prisma/schema.prisma, как и в server/.env
      DATABASE_URL: process.env.E2E_DATABASE_URL || 'file:../data/e2e.db',
      // наружу не ходим: ни Notion, ни Anthropic, ни каталоги ISBN
      NOTION_TOKEN_V2: '',
      ANTHROPIC_API_KEY: '',
      GOOGLE_BOOKS_KEY: '',
      // 0 полностью выключает фоновый синк: иначе он затянул бы в базу
      // весь настоящий каталог проекта из открытого Notion
      NOTION_SYNC_HOURS: '0',
      // как на проде: модерация ВКЛЮЧЕНА. Владелец из fixtures — админ, его
      // книги публикуются сразу; книга обычного участника уходит на проверку
      MODERATION_ON: '1',
      ADMIN_IDS: '9000001',
    },
  },
  globalSetup: './global-setup.mts',
})
