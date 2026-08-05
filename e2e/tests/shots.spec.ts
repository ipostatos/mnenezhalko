import { test, expect, asPerson, signInitData, OWNER, READER } from '../fixtures'
import { mkdirSync } from 'node:fs'

/**
 * Снимки экранов на ширине 390 px — визуальная приёмка ТЗ 5.08.2026.
 *
 * Это не сравнение с эталоном (пиксельные эталоны на живой базе только шумят),
 * а способ ПОСМОТРЕТЬ на все затронутые экраны разом и проверить главное машинно:
 * горизонтального переполнения быть не должно ни на одном.
 *
 * Запуск отдельно: npm run test:e2e -- --grep "снимок"
 */
const DIR = process.env.SHOTS_DIR || 'shots'
mkdirSync(DIR, { recursive: true })

test.describe.configure({ mode: 'serial' })

/** Страница не должна прокручиваться вбок: это правило проекта, а не вкус. */
async function noSideScroll(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(() => {
    const d = document.documentElement
    return { scroll: d.scrollWidth, client: d.clientWidth }
  })
  expect(overflow.scroll, 'страница уехала вбок').toBeLessThanOrEqual(overflow.client + 1)
}

const SCREENS: Array<[name: string, url: string]> = [
  ['home', '/'],
  ['library', '/?screen=library'],
  ['loans', '/?screen=loans'],
  ['myshelf', '/?screen=myshelf'],
  ['events', '/?screen=events'],
  ['clubs', '/?screen=clubs'],
  ['about', '/?screen=about'],
  ['add', '/?screen=add'],
]

for (const [name, url] of SCREENS) {
  test(`снимок 390px: ${name}`, async ({ page }) => {
    await asPerson(page, OWNER)
    await page.goto(url)
    await page.waitForTimeout(600) // дать приехать данным и обложкам
    await noSideScroll(page)
    await page.screenshot({ path: `${DIR}/${name}-390.png`, fullPage: true })
  })
}

test('снимок 390px: длинные названия не ломают полку', async ({ page, request }) => {
  const long =
    'Bardzo długi tytuł książki po polsku, który nie mieści się w jednej linii — Очень длинное название книги на русском языке'
  await request.post('/api/books', {
    headers: { 'X-Init-Data': signInitData(OWNER) },
    data: { title: long, author: 'Автор с очень длинным именем и отчеством', city: 'Warszawa' },
  })

  await asPerson(page, OWNER)
  await page.goto('/?screen=myshelf')
  await expect(page.locator('.shelf-card').first()).toBeVisible()
  await noSideScroll(page)
  await page.screenshot({ path: `${DIR}/myshelf-long-390.png`, fullPage: true })
})

test('снимок 390px: карточка встречи с действием', async ({ page, request }) => {
  await request.post('/api/events', {
    headers: { 'X-Init-Data': signInitData(OWNER) },
    data: {
      city: 'Warszawa',
      title: 'Книжный обмен и разговоры о прочитанном',
      startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      place: 'Кафе на Мокотове',
      description: 'Приносите книги, которыми не жалко поделиться.',
    },
  })

  await asPerson(page, OWNER)
  await page.goto('/?screen=events')
  await expect(page.locator('.row-card').first()).toBeVisible()
  await noSideScroll(page)
  await page.screenshot({ path: `${DIR}/events-card-390.png`, fullPage: true })

  await page.locator('.row-card').first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.screenshot({ path: `${DIR}/events-sheet-390.png`, fullPage: true })
})

test('снимок 390px: пустые состояния у нового человека', async ({ page }) => {
  await asPerson(page, READER)
  await page.goto('/?screen=myshelf')
  await page.waitForTimeout(400)
  await noSideScroll(page)
  await page.screenshot({ path: `${DIR}/myshelf-empty-390.png`, fullPage: true })

  await page.goto('/?screen=loans')
  await page.waitForTimeout(400)
  await noSideScroll(page)
  await page.screenshot({ path: `${DIR}/loans-empty-390.png`, fullPage: true })
})
