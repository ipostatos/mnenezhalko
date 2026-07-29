import { test, expect, asPerson, alertsOf, signInitData, OWNER, READER } from '../fixtures'

/**
 * Главный путь человека в проекте, целиком и в браузере:
 *
 *   поставил книгу на полку → нашёл её в каталоге → выдал знакомому →
 *   второй человек встал в очередь → книга вернулась → владелец оценил её
 *
 * Каждый шаг по отдельности проверяется тестами сервера и экранов, но именно
 * стыки между ними до сих пор проверялись только руками. Здесь всё настоящее:
 * собранный Mini App, живой сервер, база из миграций и подпись Telegram.
 */

/** Название своё на каждый прогон: база чистая, но так падение читается легче. */
const TITLE = `Сквозная книга ${Date.now().toString(36)}`
const AUTHOR = 'Автор Сквозной'

let bookId = ''

test.describe.configure({ mode: 'serial' })

test('владелец ставит книгу на полку', async ({ page }) => {
  await asPerson(page, OWNER)
  await page.goto('/?screen=add')

  await page.getByPlaceholder('Название *').fill(TITLE)
  await page.getByPlaceholder('Автор').fill(AUTHOR)
  await page.getByRole('button', { name: 'Warszawa', exact: true }).click()

  // жанр выбирается ТОЛЬКО из справочника проекта: своего значения тут не ввести
  await expect(page.getByPlaceholder('Найти жанр…')).toBeVisible()
  await page.getByRole('button', { name: 'Классика', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Классика', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  await page.getByRole('button', { name: 'Поставить на полку' }).click()
  await expect(page.getByText('Книга на полке!')).toBeVisible()
})

test('книга видна на своей полке с жанром и без города в карточке', async ({ page }) => {
  await asPerson(page, OWNER)
  await page.goto('/?screen=myshelf')

  const card = page.locator('.shelf-card', { hasText: TITLE })
  await expect(card).toBeVisible()
  await expect(card.getByText('Классика')).toBeVisible()
  // город стоит один раз наверху экрана, в карточке его быть не должно
  await expect(page.locator('.shelf-city')).toContainText('Warszawa')
  await expect(card.locator('.shelf-meta')).toHaveText(AUTHOR)
  await expect(page.getByText('На полке', { exact: false }).first()).toBeVisible()
})

test('книга появилась в каталоге', async ({ page, request }) => {
  const res = await request.get(`/api/books?q=${encodeURIComponent(TITLE)}`)
  expect(res.ok()).toBeTruthy()
  const found = await res.json()
  expect(found.total).toBe(1)
  bookId = found.items[0].id

  await asPerson(page, OWNER)
  await page.goto(`/?screen=book&id=${bookId}`)
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible()
  // язык отделён от жанра подписью, а не стоит такой же плашкой рядом
  await expect(page.getByText('язык: Русский')).toBeVisible()
})

test('владелец выдаёт книгу, выбрав её из полного списка полки', async ({ page }) => {
  await asPerson(page, OWNER)
  await page.goto('/?screen=loans')

  await page.getByRole('button', { name: /Выбрать из своей полки/ }).click()
  await page.locator('.sheet .pick-row', { hasText: TITLE }).click()
  await expect(page.getByPlaceholder('Название книги *')).toHaveValue(TITLE)

  await page.getByPlaceholder('@ник читателя *').fill(`@${READER.username}`)
  await page.getByRole('button', { name: 'Записать выдачу' }).click()

  await expect(page.getByText('Открыть ссылку-приглашение')).toBeVisible()
  await expect(page.locator('.loan-card', { hasText: TITLE })).toBeVisible()
})

test('второй человек встаёт в очередь на занятую книгу', async ({ page }) => {
  await asPerson(page, READER)
  await page.goto(`/?screen=book&id=${bookId}`)

  const block = page.locator('.wait-block')
  await expect(block).toContainText('Сейчас на руках')
  await block.getByRole('button', { name: /Сообщить, когда освободится/ }).click()

  await expect(block).toContainText('Вы 1-й в очереди')
})

test('владельцу видно, что книгу ждут, но не кто именно', async ({ page, request }) => {
  await asPerson(page, OWNER)
  await page.goto('/?screen=myshelf')

  const card = page.locator('.shelf-card', { hasText: TITLE })
  await expect(card).toContainText('Эту книгу ждёт 1 человек')

  // сама ручка не должна отдавать чужой tgId ни в каком виде
  const raw = await (await request.get('/api/books/' + bookId)).text()
  expect(raw).not.toContain(String(READER.id))
})

test('книга возвращается, и очередь двигается', async ({ page, request }) => {
  await asPerson(page, OWNER)
  await page.goto('/?screen=loans')

  await page.locator('.loan-card', { hasText: TITLE }).getByRole('button', { name: /вернулась/ }).click()
  // подтверждение Telegram отвечает «да» само (см. fixtures)
  await expect.poll(async () => (await alertsOf(page)).length).toBeGreaterThan(0)
  await expect(page.getByText('Сейчас у читателей ничего нет.')).toBeVisible()

  const card = await (await request.get('/api/books/' + bookId)).json()
  expect(card.status).toBe('free')
})

test('владелец оценивает свою книгу, оценка видна в каталоге', async ({ page, request }) => {
  await asPerson(page, OWNER)
  await page.goto(`/?screen=book&id=${bookId}`)

  await page.getByRole('button', { name: 'Оценка 5 из 5' }).click()
  await page.getByPlaceholder(/Пара слов о книге/).fill('Сквозная проверка дошла до конца')
  await page.getByRole('button', { name: 'Оценить книгу' }).click()
  await expect(page.getByText('Спасибо, записал.')).toBeVisible()

  const found = await (await request.get(`/api/books?q=${encodeURIComponent(TITLE)}`)).json()
  expect(found.items[0].rating).toMatchObject({ avg: 5, count: 1 })
})

test('чужой человек не может ни выдать, ни удалить чужую книгу', async ({ request }) => {
  const headers = { 'X-Init-Data': signInitData(READER) }

  const lend = await request.post('/api/loans', {
    headers,
    data: { title: TITLE, bookId, holder: '@somebody' },
  })
  expect(lend.status()).toBe(400)
  expect((await lend.json()).error).toBe('not_your_book')

  const remove = await request.post(`/api/books/${bookId}/delete`, { headers, data: {} })
  expect(remove.status()).toBe(403)
})
