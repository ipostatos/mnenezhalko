import { test, expect, asPerson, signInitData, OWNER, READER } from '../fixtures'

/**
 * Модерация книг целиком, в браузере и на живом сервере (A2, ТЗ 5.08.2026).
 *
 * Повод: участница добавила книгу, и та сразу оказалась в каталоге. Проверка
 * прода показала, что MODERATION_ON=1 работает, а книгу вносил администратор —
 * то есть сработало право модератора публиковать свои книги. Правило оставлено,
 * но теперь интерфейс обязан назвать причину: молчаливая мгновенная публикация
 * неотличима от сломанной проверки.
 *
 * Сервер здесь поднят с MODERATION_ON=1 — как на проде (см. playwright.config.ts).
 */
const PERSON_BOOK = `Книга участника ${Date.now().toString(36)}`
const ADMIN_BOOK = `Книга админа ${Date.now().toString(36)}`

test.describe.configure({ mode: 'serial' })

async function addBook(page: import('@playwright/test').Page, title: string) {
  await page.goto('/?screen=add')
  await page.getByPlaceholder('Название *').fill(title)
  await page.getByRole('button', { name: 'Warszawa', exact: true }).click()
  await page.getByRole('button', { name: 'Поставить на полку' }).click()
}

test('книга обычного участника уходит на проверку и в каталог не попадает', async ({
  page,
  request,
}) => {
  await asPerson(page, READER)
  await addBook(page, PERSON_BOOK)

  await expect(page.getByText(/на проверку модератору/i)).toBeVisible()

  const found = await (
    await request.get(`/api/books?q=${encodeURIComponent(PERSON_BOOK)}`)
  ).json()
  expect(found.total).toBe(0)
})

test('на своей полке участник видит книгу как «на проверке»', async ({ page }) => {
  await asPerson(page, READER)
  await page.goto('/?screen=myshelf')
  const card = page.locator('.shelf-card', { hasText: PERSON_BOOK })
  await expect(card).toBeVisible()
  await expect(page.getByText('На проверке', { exact: false }).first()).toBeVisible()
})

test('администратор видит книгу в «Разборе» и может её одобрить', async ({ page, request }) => {
  await asPerson(page, OWNER)
  await page.goto('/?screen=admin')

  const row = page.locator('.shelf-card', { hasText: PERSON_BOOK })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: /Одобрить/ }).click()

  await expect.poll(async () => {
    const found = await (
      await request.get(`/api/books?q=${encodeURIComponent(PERSON_BOOK)}`)
    ).json()
    return found.total
  }).toBe(1)
})

test('администратору объясняют, почему его книга опубликована сразу', async ({ page, request }) => {
  await asPerson(page, OWNER)
  await addBook(page, ADMIN_BOOK)

  await expect(page.getByText(/потому что вы администратор/i)).toBeVisible()

  const found = await (await request.get(`/api/books?q=${encodeURIComponent(ADMIN_BOOK)}`)).json()
  expect(found.total).toBe(1)
})

test('модерация не отдаёт неодобренное наружу и не пускает чужого в разбор', async ({
  request,
}) => {
  const queue = await request.get('/api/admin/moderation', {
    headers: { 'X-Init-Data': signInitData(READER) },
  })
  expect([401, 403]).toContain(queue.status())
})
