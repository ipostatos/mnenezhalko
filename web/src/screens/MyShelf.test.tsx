/**
 * Счётчики на «Моей полке» (жалоба 29 июля: «выглядит как кнопки, но нажать
 * нельзя»).
 *
 * Плитки и раньше рисовались с пальцем-курсором и откликом на нажатие, но были
 * обычными блоками: человек жал в пустоту. Здесь проверяется, что счётчик —
 * настоящая кнопка и что нажатие делает осмысленное: фильтрует полку.
 *
 * Запуск: npm run test -w web
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MyShelf } from './MyShelf'
import { api } from '../api'
import type { ShelfBook } from '../types'

const shelfBook = (over: Partial<ShelfBook> & { title: string; state: ShelfBook['state'] }): ShelfBook => ({
  id: over.title,
  kind: 'book',
  author: null,
  genres: [],
  languages: [],
  city: 'Warszawa',
  district: null,
  coverUrl: null,
  status: 'free',
  source: 'bot',
  owner: null,
  ...over,
})

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(api, 'badges').mockRejectedValue(new Error('нет значков'))
  vi.spyOn(api, 'myShelf').mockResolvedValue({
    books: [
      shelfBook({ title: 'На полке раз', state: 'active' }),
      shelfBook({ title: 'На полке два', state: 'active' }),
      shelfBook({ title: 'У читателя', state: 'onloan', status: 'busy' }),
    ],
  } as any)
})

describe('счётчики на «Моей полке»', () => {
  test('счётчики — настоящие кнопки, а не блоки, которые притворяются', async () => {
    const { container } = render(<MyShelf go={() => {}} />)
    await screen.findByText('На полке раз')

    const tiles = container.querySelectorAll('.stat-tiles .s')
    expect(tiles.length).toBe(3)
    for (const tile of tiles) expect(tile.tagName).toBe('BUTTON')
  })

  test('нажатие на счётчик фильтрует полку, повторное — снимает фильтр', async () => {
    render(<MyShelf go={() => {}} />)
    await screen.findByText('На полке раз')
    expect(screen.getByText('У читателя')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^На руках: 1/ }))
    await waitFor(() => expect(screen.queryByText('На полке раз')).toBeNull())
    expect(screen.getByText('У читателя')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^На руках: 1/ }))
    await waitFor(() => expect(screen.getByText('На полке раз')).toBeTruthy())
  })

  test('пустой фильтр объясняет себя и даёт выход', async () => {
    render(<MyShelf go={() => {}} />)
    await screen.findByText('На полке раз')

    fireEvent.click(screen.getByRole('button', { name: /^На проверке: 0/ }))
    expect(await screen.findByText('Книг в состоянии «на проверке» нет.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Показать все книги' }))
    await waitFor(() => expect(screen.getByText('На полке раз')).toBeTruthy())
  })
})
