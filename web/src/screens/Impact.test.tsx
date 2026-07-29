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
import { Badges } from './Badges'
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
  test('показываем обмены, злотые, бумагу и деревья', async () => {
    vi.spyOn(api, 'impact').mockResolvedValue(impact())
    render(<Impact />)

    expect(await screen.findByText('≈8000')).toBeTruthy()
    expect(screen.getByText('200 обменов книгами')).toBeTruthy()
    expect(screen.getByText('≈60')).toBeTruthy()
    expect(screen.getByText('≈1')).toBeTruthy()
    expect(screen.getByText('дерево')).toBeTruthy()
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

    expect(await screen.findByText('≈120')).toBeTruthy()
    expect(screen.getByText('≈0.9')).toBeTruthy()
    expect(screen.queryByText('≈0.02')).toBeNull()
  })

  test('методику можно раскрыть прямо в блоке', async () => {
    vi.spyOn(api, 'impact').mockResolvedValue(impact())
    render(<Impact />)

    fireEvent.click(await screen.findByRole('button', { name: 'Как это посчитано' }))
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
  test('заработанные показаны, незаработанные бледные и с прогрессом', async () => {
    vi.spyOn(api, 'badges').mockResolvedValue({
      badges: [
        badge(),
        badge({ id: 'shelf-10', title: 'Полка на десять', earned: false, current: 7, target: 10 }),
      ],
    })
    const { container } = render(<Badges />)

    expect(await screen.findByText('Первая книга')).toBeTruthy()
    expect(screen.getByText('1 из 2')).toBeTruthy()
    expect(screen.getByText('7 из 10')).toBeTruthy()
    expect(container.querySelectorAll('.badge.locked').length).toBe(1)
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
