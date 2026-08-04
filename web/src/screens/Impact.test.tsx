/**
 * Блок «Польза сообщества» (issue #13) и значки библиотекаря (issue #11).
 *
 * Проверяется то, что легко сломать незаметно: блок не приветствует нулями,
 * в свёрнутом виде остаётся один главный показатель, спорная методика видна
 * при раскрытии, а «деревья» не показываются, пока их набралась смешная доля.
 *
 * Запуск: npm run test -w web
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { Impact, treeWord, exchangeWord, group } from './Impact'
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

describe('польза сообщества', () => {
  test('в свёрнутом виде один главный показатель, метрики и методика скрыты', async () => {
    vi.spyOn(api, 'impact').mockResolvedValue(impact())
    const { container } = render(<Impact />)

    expect(await screen.findByText('Польза сообщества')).toBeTruthy()
    // сумма — единственная крупная цифра, разряды разделены
    expect(container.querySelector('.impact-hero')?.textContent).toBe(`≈${group(8000)} zł`)
    expect(screen.getByText(/сберегли вместе · 200 обменов/)).toBeTruthy()
    // цифры и методика спрятаны, пока не попросили
    expect(screen.queryByText('бумаги сохранили')).toBeNull()
    expect(screen.queryByText('Как считаем')).toBeNull()
  })

  test('по нажатию раскрываются две карточки и деревья, и сворачиваются обратно', async () => {
    vi.spyOn(api, 'impact').mockResolvedValue(impact())
    const { container } = render(<Impact />)

    const head = await screen.findByRole('button', { name: /Польза сообщества/ })
    fireEvent.click(head)
    // ровно две метрики: деньги и экология, а не три равноправных колонки
    expect(container.querySelectorAll('.impact-num').length).toBe(2)
    expect(screen.getByText('≈60 кг')).toBeTruthy()
    expect(screen.getByText('бумаги сохранили')).toBeTruthy()
    expect(screen.getByText('это ≈1 дерево')).toBeTruthy()

    fireEvent.click(head)
    await waitFor(() => expect(screen.queryByText('бумаги сохранили')).toBeNull())
  })

  test('деньги и экология окрашены по-разному: цвет несёт смысл', async () => {
    vi.spyOn(api, 'impact').mockResolvedValue(impact())
    const { container } = render(<Impact />)

    fireEvent.click(await screen.findByRole('button', { name: /Польза сообщества/ }))
    expect(container.querySelector('.impact-num.money')).toBeTruthy()
    expect(container.querySelector('.impact-num.eco')).toBeTruthy()
  })

  test('без обменов блок молчит: «сберегли 0 злотых» — плохое приветствие', async () => {
    vi.spyOn(api, 'impact').mockResolvedValue(impact({ exchanges: 0, moneyPln: 0, paperKg: 0, trees: 0 }))
    const { container } = render(<Impact />)
    await waitFor(() => expect(container.textContent).toBe(''))
  })

  test('пока деревьев меньше десятой доли — строки нет, а деньги и бумага есть', async () => {
    vi.spyOn(api, 'impact').mockResolvedValue(
      impact({ exchanges: 3, moneyPln: 120, paperKg: 0.9, trees: 0.02 }),
    )
    const { container } = render(<Impact />)

    fireEvent.click(await screen.findByRole('button', { name: /Польза сообщества/ }))
    expect(screen.getByText('≈0.9 кг')).toBeTruthy()
    expect(container.querySelector('.impact-num .x')).toBeNull()
  })

  test('методика видна при раскрытии списком: спорную оценку честнее показать', async () => {
    vi.spyOn(api, 'impact').mockResolvedValue(impact())
    const { container } = render(<Impact />)

    fireEvent.click(await screen.findByRole('button', { name: /Польза сообщества/ }))
    expect(screen.getByText('Как считаем')).toBeTruthy()
    expect(container.querySelectorAll('.impact-how li').length).toBe(3)
    expect(screen.getByText(/40 zł за книгу/)).toBeTruthy()
    expect(screen.getByText(/приблизительная оценка, а не точный расчёт/)).toBeTruthy()
  })

  test('разряды в сумме: «8000» читается как набор цифр, «8 000» — как деньги', () => {
    expect(group(8000)).toBe('8 000')
    expect(group(120)).toBe('120')
    expect(group(1234567)).toBe('1 234 567')
  })

  test('склонение обменов', () => {
    expect([1, 2, 5, 11, 22].map(exchangeWord)).toEqual([
      'обмен',
      'обмена',
      'обменов',
      'обменов',
      'обмена',
    ])
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
  test('лента: заработанные, ближайшая цель бледной', async () => {
    vi.spyOn(api, 'badges').mockResolvedValue({
      badges: [
        badge(),
        badge({ id: 'shelf-10', title: 'Полка на десять', earned: false, current: 7, target: 10 }),
      ],
    })
    const { container } = render(<Badges />)

    await waitFor(() => expect(container.querySelectorAll('.badge').length).toBe(2))
    expect(screen.getByText('1 из 2')).toBeTruthy()
    expect(screen.getByText('7 из 10')).toBeTruthy()
    // у полученного значка не задание, а отметка «сделано»
    expect(screen.getByText('Получено')).toBeTruthy()
    expect(container.querySelectorAll('.badge.locked').length).toBe(1)
    // на время подстройки под платформу рисунки значков спрятаны (HIDE_BADGE_ART),
    // показываем эмодзи; когда картинки вернут — вернуть и проверку img.badge-img
    expect(container.querySelectorAll('.badge-emoji').length).toBe(2)
    expect(container.querySelector('img.badge-img')).toBeNull()
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

  // пока рисунки значков спрятаны (HIDE_BADGE_ART), карточка показывает эмодзи.
  // Когда картинки вернут, сюда вернётся проверка onError-фолбэка на img.
  test('пока рисунки значков спрятаны, карточка показывает эмодзи', async () => {
    vi.spyOn(api, 'badges').mockResolvedValue({ badges: [badge()] })
    const { container } = render(<Badges />)

    await waitFor(() => expect(container.querySelector('.badge-emoji')?.textContent).toBe('📗'))
    expect(container.querySelector('img.badge-img')).toBeNull()
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
