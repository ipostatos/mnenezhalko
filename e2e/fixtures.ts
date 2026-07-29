import crypto from 'node:crypto'
import { test as base, type Page } from '@playwright/test'

const BOT_TOKEN = process.env.E2E_BOT_TOKEN || '424242:e2e-test-token'

export type TgPerson = {
  id: number
  username: string
  first_name: string
}

/** Владелец полки (он же админ: его книги не идут на модерацию). */
export const OWNER: TgPerson = { id: 9000001, username: 'e2e_owner', first_name: 'Аня' }
/** Второй человек: берёт книгу и встаёт в очередь. */
export const READER: TgPerson = { id: 9000002, username: 'e2e_reader', first_name: 'Борис' }

/**
 * Подпись Telegram ровно тем же способом, что и настоящая: сервер проверяет
 * её через HMAC от токена бота, поэтому подделать её можно только зная
 * тестовый токен. Никакого послабления в проверке подписи ради тестов нет.
 */
export function signInitData(user: TgPerson): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify(user),
  })
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n')
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  params.set(
    'hash',
    crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex'),
  )
  return params.toString()
}

/**
 * Подставляет `window.Telegram.WebApp` до загрузки приложения: модуль
 * `telegram.ts` читает его на импорте, позже подменить уже нельзя.
 *
 * Диалоги Telegram заменены на автоответ «да» и запись в `window.__alerts`,
 * иначе нативное окно подтверждения возврата остановило бы весь прогон.
 */
export async function asPerson(page: Page, user: TgPerson) {
  const initData = signInitData(user)

  // ⚠️ index.html подключает настоящий SDK с telegram.org, и он ЗАТИРАЕТ наш
  // объект своим — с пустым initData. Поэтому скрипт подменяем заглушкой:
  // заодно сквозной прогон перестаёт зависеть от доступности telegram.org
  await page.route(/telegram-web-app\.js/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: '/* в сквозных проверках вместо SDK — объект из fixtures.ts */',
    }),
  )
  // аргумент передаём ОДНИМ объектом и разбираем внутри: деструктуризация прямо
  // в параметрах init-скрипта приезжала в браузер пустой
  await page.addInitScript(
    (data: { initData: string; user: TgPerson }) => {
      ;(window as any).__alerts = []
      ;(window as any).Telegram = {
        WebApp: {
          initData: data.initData,
          initDataUnsafe: { user: data.user },
          version: '7.0',
          platform: 'e2e',
          ready() {},
          expand() {},
          disableVerticalSwipes() {},
          setBackgroundColor() {},
          setHeaderColor() {},
          setBottomBarColor() {},
          HapticFeedback: {
            impactOccurred() {},
            notificationOccurred() {},
            selectionChanged() {},
          },
          showAlert(message: string, cb?: () => void) {
            ;(window as any).__alerts.push(message)
            cb?.()
          },
          showConfirm(message: string, cb?: (ok: boolean) => void) {
            ;(window as any).__alerts.push(message)
            cb?.(true)
          },
          openTelegramLink() {},
          openLink() {},
          BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
        },
      }
    },
    { initData, user },
  )
}

/** Тексты, которые приложение показало через нативный диалог Telegram. */
export const alertsOf = (page: Page) => page.evaluate(() => (window as any).__alerts as string[])

export const test = base
export { expect } from '@playwright/test'
