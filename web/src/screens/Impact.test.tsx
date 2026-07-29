/**
 * Блок «Вместе мы сберегли» (issue #13) и значки библиотекаря (issue #11).
 *
 * Проверяется то, что легко сломать незаметно: блок не приветствует нулями,
 * спорная методика остаётся на виду, а «деревья» не показываются, пока их
 * набралась смешная доля.
 *
 * Запуск: npm run test -w web
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { Impact, treeWord } from './Impact'
import { Badges, BadgesScreen } from './Badges'
import { api } from '../api'
import type { Badge, Impact as ImpactData } from '../types'

const impact = (over: Partial<ImpactData> = {}): ImpactData => ({
  exchanges: 200,
  moneyPln: 8000,
  paperKg: 60,
  trees: 1,
  basis: { pricePln: 40, paperPerBookKg: 0.3, paperPerTreeKg: 60 },
  ...over,
})

const badge = (over: Partial<Badge> = {}): Badge => ({
  id: 'first-book',
  title: 'Первая книга',
  hint: 'Поставить на полку первую книгу',
  emoji: '📗',
  earned: true,
  current: 1,
  target: 1,
  ...over,
})

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('сколько сберегли вместе', () => {
  test('на главной свёрнут в одну строку: место под плашки, а не под статистику', async () => {
    vi.spyOn(api, 'impact').mockResolvedValue(impact())
    render(<Impact />)

    expect(await screen.findByText('Вместе мы сберегли ≈8000 zł')).toBeTruthy()
    // цифры и методика спрятаны, пока не попросили
    expect(screen.queryByText('кг бумаги')).toBeNull()
    expect(screen.queryByText(/40 злотых за книгу/)).toBeNull()
  })

  test('по нажатию раскрываются злотые, бумага и деревья, и сворачиваются обратно', async () => {
    vi.spyOn(api, 'impact').mockResolvedValue(impact())
    render(<Impact />)

    const head = await screen.findByRole('button', { name: /Вместе мы сберегли/ })
    fireEvent.click(head)
    expect(screen.getByText('≈60')).toBeTruthy()
    expect(screen.getByText('кг бумаги')).toBeTruthy()
    expect(screen.getByText('дерево')).toBeTruthy()

    fireEvent.click(head)
    await waitFor(() => expect(screen.queryByText('кг бумаги')).toBeNull())
  })

  test('без обменов блок молчит: «сберегли 0 злотых» — плохое приветствие', async () => {
    vi.spyOn(api, 'impact').mockResolvedValue(impact({ exchanges: 0, moneyPln: 0, paperKg: 0, trees: 0 }))
    const { container } = render(<Impact />)
    await waitFor(() => expect(container.textContent).toBe(''))
  })

  test('пока деревьев меньше десятой доли — колонки нет, а деньги и бумага есть', async () => {
    vi.spyOn(api, 'impact').mockResolvedValue(
      impact({ exchanges: 3, moneyPln: 120, paperKg: 0.9, trees: 0.02 }),
    )
    render(<Impact />)

    fireEvent.click(await screen.findByRole('button', { name: /Вместе мы сберегли/ }))
    expect(screen.getByText('≈0.9')).toBeTruthy()
    expect(screen.queryByText('≈0.02')).toBeNull()
  })

  test('методика видна при раскрытии: спорную оценку честнее показать', async () => {
    vi.spyOn(api, 'impact').mockResolvedValue(impact())
    render(<Impact />)

    fireEvent.click(await screen.findByRole('button', { name: /Вместе мы сберегли/ }))
    expect(screen.getByText(/40 злотых за книгу/)).toBeTruthy()
    expect(screen.getByText(/оценка, а не точный расчёт/)).toBeTruthy()
  })

  test('склонение деревьев', () => {
    expect([1, 2, 5, 11, 21, 0.5].map(treeWord)).toEqual([
      'дерево',
      'дерева',
      'деревьев',
      'деревьев',
      'дерево',
      'дерева',
    ])
  })
})

describe('значки библиотекаря', () => {
  test('лента: заработанные, ближайшая цель бледной, у каждого своя картинка', async () => {
    vi.spyOn(api, 'badges').mockResolvedValue({
      badges: [
        badge(),
        badge({ id: 'shelf-10', title: 'Полка на десять', earned: false, current: 7, target: 10 }),
      ],
    })
    const { container } = render(<Badges />)

    expect(await screen.findByAltText('Первая книга')).toBeTruthy()
    expect(screen.getByText('1 из 2')).toBeTruthy()
    expect(screen.getByText('7 из 10')).toBeTruthy()
    // у полученного значка не задание, а отметка «сделано»
    expect(screen.getByText('Получено')).toBeTruthy()
    expect(container.querySelectorAll('.badge.locked').length).toBe(1)
    // название написано на самой картинке, поэтому проверяем её адрес
    expect(container.querySelector('img.badge-img')?.getAttribute('src')).toBe(
      '/ach/first-book.webp',
    )
  })

  test('на «Моей полке» показываем не весь список, а достигнутое и ближайшую цель', async () => {
    vi.spyOn(api, 'badges').mockResolvedValue({
      badges: [
        badge(),
        badge({ id: 'shelf-10', earned: false, current: 7, target: 10 }),
        badge({ id: 'shelf-25', earned: false, current: 1, target: 25 }),
        badge({ id: 'reader-3', earned: false, current: 0, target: 3 }),
      ],
    })
    const { container } = render(<Badges />)

    await waitFor(() => expect(container.querySelectorAll('.badge').length).toBe(2))
    expect(screen.getByText('7 из 10')).toBeTruthy()
  })

  test('отдельный экран показывает все значки и объясняет приватность', async () => {
    vi.spyOn(api, 'badges').mockResolvedValue({
      badges: [badge(), badge({ id: 'shelf-10', earned: false, current: 7, target: 10 })],
    })
    const { container } = render(<BadgesScreen />)

    expect(await screen.findByText('Мои достижения')).toBeTruthy()
    expect(screen.getByText('Получено 1 из 2. Остальные ждут своего часа.')).toBeTruthy()
    await waitFor(() => expect(container.querySelectorAll('.badge-grid .badge').length).toBe(2))
    expect(screen.getByText(/общего рейтинга библиотекарей в проекте нет/)).toBeTruthy()
  })

  test('картинка не загрузилась — вместо неё запасной символ, карточка цела', async () => {
    vi.spyOn(api, 'badges').mockResolvedValue({ badges: [badge()] })
    const { container } = render(<Badges />)

    const img = (await screen.findByAltText('Первая книга')) as HTMLImageElement
    fireEvent.error(img)
    await waitFor(() => expect(container.querySelector('.badge-emoji')?.textContent).toBe('📗'))
  })

  test('новичку витрину серых кружков не показываем', async () => {
    vi.spyOn(api, 'badges').mockResolvedValue({
      badges: [badge({ earned: false, current: 0 })],
    })
    const { container } = render(<Badges />)
    await waitFor(() => expect(container.textContent).toBe(''))
  })

  test('сбой значков не ломает «Мою полку»', async () => {
    vi.spyOn(api, 'badges').mockRejectedValue(new Error('HTTP 500'))
    const { container } = render(<Badges />)
    await waitFor(() => expect(container.textContent).toBe(''))
  })
})
