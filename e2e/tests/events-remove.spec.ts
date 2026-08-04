import { test, expect, asPerson, signInitData, OWNER, READER } from '../fixtures'

/**
 * Уборка прошедшей встречи админом — жестом, в настоящем браузере.
 *
 * Тесты сервера проверяют права и переходы, тесты экрана — что блок появляется
 * и что подтверждение спрашивают. Здесь проверяется именно то, что между ними:
 * свайп влево действительно открывает корзину, а не пролистывает страницу,
 * и после уборки встреча пропадает из афиши.
 *
 * OWNER в сквозных прогонах админ, READER — обычный участник.
 */

const TITLE = `Прошедшая встреча ${Date.now().toString(36)}`
const UPCOMING = `Предстоящая встреча ${Date.now().toString(36)}`

test.describe.configure({ mode: 'serial' })

test('админ заводит прошедшую и предстоящую встречи', async ({ request }) => {
  const headers = { 'X-Init-Data': signInitData(OWNER) }
  const past = await request.post('/api/events', {
    headers,
    data: {
      city: 'Warszawa',
      title: TITLE,
      startsAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      place: 'Кафе на Воле',
    },
  })
  expect(past.ok()).toBeTruthy()

  const upcoming = await request.post('/api/events', {
    headers,
    data: {
      city: 'Warszawa',
      title: UPCOMING,
      startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    },
  })
  expect(upcoming.ok()).toBeTruthy()
})

test('обычный участник прошедших не видит', async ({ page }) => {
  await asPerson(page, READER)
  await page.goto('/')
  await page.getByText('Ближайшие встречи').click()

  await expect(page.getByText(UPCOMING)).toBeVisible()
  await expect(page.getByText(/Прошедшие/)).toHaveCount(0)
  await expect(page.getByText(TITLE)).toHaveCount(0)
})

test('админ убирает прошедшую встречу свайпом влево', async ({ page }) => {
  await asPerson(page, OWNER)
  await page.goto('/')
  await page.getByText('Ближайшие встречи').click()

  // в афише — только предстоящая: прошедшая лежит в свёрнутом блоке уборки
  // (в разметке она есть, но человеку не показана, пока он не развернёт)
  await expect(page.getByText(UPCOMING)).toBeVisible()
  await expect(page.getByText(TITLE)).toBeHidden()

  await page.getByText(/Прошедшие/).click()
  const card = page.getByText(TITLE)
  await expect(card).toBeVisible()

  // корзина лежит под строкой и до жеста прозрачна
  const trash = page.getByLabel(`Убрать «${TITLE}»`)
  await expect(trash).toHaveCSS('opacity', '0')

  const box = (await card.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width - 20, y)
  await page.mouse.down()
  // ведём с промежуточными точками: один прыжок курсора жестом не считается
  await page.mouse.move(box.x + box.width - 60, y, { steps: 5 })
  await page.mouse.move(box.x + box.width - 120, y, { steps: 5 })
  await page.mouse.up()

  await expect(trash).toHaveCSS('opacity', '1')

  // корзина лежит ПОД строкой во всю ширину, открыта только полоса справа:
  // клик в середину пришёлся бы по самой строке, поэтому целимся в полосу
  const bb = (await trash.boundingBox())!
  await trash.click({ position: { x: bb.width - 40, y: bb.height / 2 } })
  await expect(page.getByText(TITLE)).toHaveCount(0)
  await expect(page.getByText(/Прошедшие/)).toHaveCount(0)
})

test('убранная встреча не возвращается и не трогает предстоящую', async ({ page, request }) => {
  await asPerson(page, OWNER)
  await page.goto('/')
  await page.getByText('Ближайшие встречи').click()

  await expect(page.getByText(UPCOMING)).toBeVisible()
  await expect(page.getByText(/Прошедшие/)).toHaveCount(0)

  // и с той стороны, где живут данные: в афише предстоящая, в архиве пусто
  const headers = { 'X-Init-Data': signInitData(OWNER) }
  const afisha = await (await request.get('/api/events')).json()
  expect(afisha.map((e: { title: string }) => e.title)).toContain(UPCOMING)
  expect(afisha.map((e: { title: string }) => e.title)).not.toContain(TITLE)

  const archive = await (await request.get('/api/admin/events/past', { headers })).json()
  expect(archive.map((e: { title: string }) => e.title)).not.toContain(TITLE)
})
