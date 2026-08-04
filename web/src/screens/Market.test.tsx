/**
 * Барахолка: как подписано место объявления.
 *
 * Пригород объявления живёт отдельно от города проекта (см. server/src/
 * agglomeration.ts): объявление из Велички относится к Кракову, но человек
 * должен видеть, что вещь не в самом Кракове. Проверяется именно подпись —
 * привязка к городу проверяется на сервере.
 *
 * Запуск: npm run test -w web
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { Market } from './Market'
import { api } from '../api'
import type { MarketItem } from '../types'

const item = (over: Partial<MarketItem> = {}): MarketItem => ({
  id: 'm1',
  city: 'Kraków',
  locality: null,
  kind: 'give',
  title: 'Стеллаж под книги',
  description: 'Самовывоз',
  price: null,
  photo: null,
  authorUsername: 'seller',
  createdAt: new Date().toISOString(),
  ...over,
})

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('место объявления', () => {
  test('пригород показан рядом с городом', async () => {
    vi.spyOn(api, 'market').mockResolvedValue([item({ locality: 'Wieliczka' })])
    render(<Market />)
    await waitFor(() => expect(screen.getByText(/Kraków \(Wieliczka\)/)).toBeTruthy())
  })

  test('город без пригорода не задваивается', async () => {
    vi.spyOn(api, 'market').mockResolvedValue([item()])
    render(<Market />)
    await waitFor(() => expect(screen.getByText(/Kraków/)).toBeTruthy())
    expect(screen.queryByText(/Kraków \(/)).toBeNull()
  })

  test('город неизвестен, но посёлок назван — показываем посёлок', async () => {
    vi.spyOn(api, 'market').mockResolvedValue([
      item({ city: 'Все города', locality: 'Козья Горка' }),
    ])
    render(<Market />)
    await waitFor(() => expect(screen.getByText(/Козья Горка/)).toBeTruthy())
    // «Все города» на карточке ничего не сообщает: место занимает, смысла не несёт
    expect(screen.queryByText(/Все города/)).toBeNull()
  })

  test('места нет вовсе — метки места нет', async () => {
    vi.spyOn(api, 'market').mockResolvedValue([item({ city: 'Все города', locality: null })])
    render(<Market />)
    await waitFor(() => expect(screen.getByText('Стеллаж под книги')).toBeTruthy())
    expect(screen.queryByText(/📍/)).toBeNull()
  })
})
