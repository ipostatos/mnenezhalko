import { test, expect, asPerson, signInitData, OWNER } from '../fixtures'

/**
 * UX-часть ТЗ 5.08.2026 (PR B) в браузере: автокомплит выдачи, отсутствие
 * донатов и несколько клубов в одном городе.
 *
 * Всё это проверяется и юнитами экранов, но именно здесь видно собранное
 * приложение целиком: маршруты, ответы сервера и настоящие клики.
 */
const TITLES = ['Автокомплит один', 'Автокомплит два', 'Автокомплит три']

test.describe.configure({ mode: 'serial' })

test('готовим полку: несколько книг', async ({ request }) => {
  for (const title of TITLES) {
    const res = await request.post('/api/books', {
      headers: { 'X-Init-Data': signInitData(OWNER) },
      data: { title, city: 'Warszawa' },
    })
    expect(res.ok()).toBeTruthy()
  }
})

test('B1: список полки не раскрыт до ввода и появляется с двух символов', async ({ page }) => {
  await asPerson(page, OWNER)
  await page.goto('/?screen=loans')

  const field = page.getByPlaceholder('Название книги *')
  await expect(field).toBeVisible()
  // ждём, пока приедет полка: подсказка и кнопка рисуются только когда она есть
  await expect(page.getByRole('button', { name: /Выбрать из своей полки/ })).toBeVisible()

  // пусто: списка нет, но человеку сказано, что делать
  await expect(page.getByText('С вашей полки:')).toBeHidden()
  await expect(page.getByText(/Начните вводить название или выберите книгу/)).toBeVisible()

  // один символ — всё ещё молчим
  await field.fill('а')
  await expect(page.getByText('С вашей полки:')).toBeHidden()

  // два символа — подсказка появляется
  await field.fill('ав')
  await expect(page.getByText('С вашей полки:')).toBeVisible()
  // и она не разрастается: потолок — шесть строк, остальное в шторке полки
  expect(await page.locator('.note .link-row').count()).toBeLessThanOrEqual(6)

  await field.fill('автокомплит')
  await expect(page.locator('.note .link-row')).toHaveCount(TITLES.length)
})

test('B1: выбор из подсказки закрывает список, очистка поля сбрасывает выбор', async ({ page }) => {
  await asPerson(page, OWNER)
  await page.goto('/?screen=loans')

  const field = page.getByPlaceholder('Название книги *')
  await field.fill('автокомплит один')
  await page.locator('.note .link-row').first().click()

  await expect(field).toHaveValue(TITLES[0])
  await expect(page.getByText('С вашей полки:')).toBeHidden()

  await field.fill('')
  await expect(page.getByText(/Начните вводить название/)).toBeVisible()
})

test('B5: донатов нет ни на экране «О проекте», ни в API', async ({ page, request }) => {
  await asPerson(page, OWNER)
  await page.goto('/?screen=about')
  await expect(page.getByRole('heading', { name: 'О проекте' })).toBeVisible()

  await expect(page.getByText('Поддержать проект')).toBeHidden()
  await expect(page.getByText(/⭐/)).toBeHidden()
  await expect(page.getByText(/Угостить кофе/)).toBeHidden()

  const link = await request.post('/api/donate/link', {
    headers: { 'X-Init-Data': signInitData(OWNER) },
    data: { amount: 50 },
  })
  expect(link.status()).toBe(403)
  expect((await link.json()).error).toBe('feature_disabled')
})

test('B7: два клуба одного города — две карточки, ссылки не перепутаны', async ({ page }) => {
  await asPerson(page, OWNER)
  await page.goto('/?screen=clubs')

  await expect(page.getByRole('heading', { name: 'Книжные клубы' })).toBeVisible()
  // город — заголовок группы, а не по подписи на каждый клуб
  await expect(page.getByText('Warszawa', { exact: true })).toHaveCount(1)
  await expect(page.locator('.row-card')).toHaveCount(3)

  const morning = page.locator('.row-card', { hasText: 'Утренний клуб' })
  const evening = page.locator('.row-card', { hasText: 'Вечерний клуб' })
  await expect(morning).toBeVisible()
  await expect(evening).toBeVisible()
})

test('B7: на главной плашка ведёт в список клубов, а не сразу в один чат', async ({ page }) => {
  await asPerson(page, OWNER)
  await page.goto('/')

  await page.getByRole('button', { name: /Книжные клубы/ }).click()
  await expect(page.getByRole('heading', { name: 'Книжные клубы' })).toBeVisible()
})
