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

describe('город и жанры на «Моей полке» (просьба user 29.07.2026)', () => {
  test('город стоит один раз вверху, а не в каждой книге', async () => {
    const { container } = render(<MyShelf go={() => {}} city="Warszawa" />)
    await screen.findByText('На полке раз')

    // одна строка «Ваш город», и ни одной подписи с городом на карточках
    expect(container.querySelectorAll('.shelf-city').length).toBe(1)
    expect(screen.getByText('Warszawa')).toBeTruthy()
    for (const meta of container.querySelectorAll('.shelf-meta')) {
      expect(meta.textContent).not.toContain('Warszawa')
    }
  })

  test('город книги показывается, только если он ОТЛИЧАЕТСЯ от вашего', async () => {
    vi.spyOn(api, 'myShelf').mockResolvedValue({
      books: [
        shelfBook({ title: 'Дома', state: 'active' }),
        shelfBook({ title: 'У родителей', state: 'active', city: 'Kraków' }),
      ],
    } as any)
    const { container } = render(<MyShelf go={() => {}} city="Warszawa" />)
    await screen.findByText('У родителей')

    const metas = [...container.querySelectorAll('.shelf-meta')].map((m) => m.textContent)
    expect(metas).toEqual(['Kraków'])
  })

  test('жанры видны на карточке — не заходя в каждую книгу', async () => {
    vi.spyOn(api, 'myShelf').mockResolvedValue({
      books: [shelfBook({ title: 'С жанром', state: 'active', genres: ['Фентези', 'Классика'] })],
    } as any)
    render(<MyShelf go={() => {}} city="Warszawa" />)
    await screen.findByText('С жанром')

    expect(screen.getByText('Фентези')).toBeTruthy()
    expect(screen.getByText('Классика')).toBeTruthy()
  })

  test('книги без жанра пересчитаны сверху и показываются фильтром', async () => {
    vi.spyOn(api, 'myShelf').mockResolvedValue({
      books: [
        shelfBook({ title: 'С жанром', state: 'active', genres: ['Классика'] }),
        shelfBook({ title: 'Без жанра', state: 'active' }),
      ],
    } as any)
    render(<MyShelf go={() => {}} city="Warszawa" />)
    await screen.findByText('Без жанра')
    expect(screen.getByText(/У 1 книги не указан жанр/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Показать эти книги' }))
    await waitFor(() => expect(screen.queryByText('С жанром')).toBeNull())
    expect(screen.getByText('Без жанра')).toBeTruthy()
  })
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

/**
 * B3 (ТЗ 5.08.2026): баннер города. Раньше он писал «Город не выбран — книги
 * встанут на полку без города»: техническая фраза без пользы и без действия.
 * Теперь объясняет выгоду, ведёт в существующий выбор города и честно говорит,
 * что старые книги сами не переедут.
 */
describe('B3: баннер города', () => {
  test('без города объясняем пользу и даём действие', async () => {
    render(<MyShelf go={() => {}} />)
    await screen.findByText('На полке раз')

    expect(screen.getByText(/чтобы ваши книги появлялись в городском фильтре/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Указать город/ })).toBeTruthy()
    // старой технической фразы больше нет
    expect(screen.queryByText(/встанут на полку без города/)).toBeNull()
    expect(screen.queryByText(/Город не выбран/)).toBeNull()
  })

  test('обещаем только то, что делаем: старые книги не переезжают', async () => {
    render(<MyShelf go={() => {}} />)
    await screen.findByText('На полке раз')
    expect(screen.getByText(/Уже добавленные останутся со своим/)).toBeTruthy()
  })

  test('действие ведёт на существующий выбор города, второго экрана не заводим', async () => {
    const routes: any[] = []
    render(<MyShelf go={(r) => routes.push(r)} />)
    await screen.findByText('На полке раз')

    fireEvent.click(screen.getByRole('button', { name: /Указать город/ }))
    expect(routes).toEqual([{ name: 'cities' }])
  })

  test('город выбран — баннера нет, есть строка с городом', async () => {
    const { container } = render(<MyShelf go={() => {}} city="Warszawa" />)
    await screen.findByText('На полке раз')

    expect(container.querySelectorAll('.shelf-city').length).toBe(1)
    expect(screen.queryByRole('button', { name: /Указать город/ })).toBeNull()
  })
})
