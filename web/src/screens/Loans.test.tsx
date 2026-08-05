/**
 * Подсказка «с вашей полки» в форме выдачи (жалоба user 29.07.2026: при вводе
 * названия приложение не помогает названиями со своей полки).
 *
 * Проверяется ровно то, что было сломано с точки зрения человека: полка видна
 * СРАЗУ, а не после двух букв; книга находится и по автору, и без оглядки на
 * регистр и ё; уже выданная книга не предлагается, но и не пропадает молча.
 *
 * Запуск: npm run test -w web
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { Loans, norm, bookMatches } from './Loans'
import { api } from '../api'
import type { Book } from '../types'

const book = (over: Partial<Book> = {}): Book => ({
  id: 'b1',
  kind: 'book',
  title: 'Мастер и Маргарита',
  author: 'Михаил Булгаков',
  genres: [],
  languages: [],
  city: 'Warszawa',
  district: null,
  coverUrl: null,
  status: 'free',
  source: 'notion',
  owner: null,
  ...over,
})

const noLoans = {
  given: [],
  taken: [],
  history: [],
  summary: { given: 0, taken: 0, overdue: 0, mood: 'ok' as const, worst: null },
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(api, 'loans').mockResolvedValue(noLoans as any)
  vi.spyOn(api, 'people').mockResolvedValue({ people: [] } as any)
})

describe('подсказка с полки в форме выдачи', () => {
  test('список полки скрыт до ввода и появляется, когда начинаешь печатать', async () => {
    // просьба user 5.08.2026: большая плашка со всей полкой сразу загромождала
    // форму — теперь список появляется только при вводе названия
    vi.spyOn(api, 'myBooks').mockResolvedValue([
      book(),
      book({ id: 'b2', title: 'Солярис', author: 'Станислав Лем' }),
    ])
    render(<Loans go={() => {}} />)

    await screen.findByPlaceholderText('Название книги *')
    expect(screen.queryByText(/С вашей полки/)).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('Название книги *'), { target: { value: 'сол' } })
    expect(await screen.findByText(/С вашей полки/)).toBeTruthy()
    expect(screen.getByText(/Солярис/)).toBeTruthy()
  })

  test('ищет по автору, а не только по названию', async () => {
    vi.spyOn(api, 'myBooks').mockResolvedValue([
      book(),
      book({ id: 'b2', title: 'Солярис', author: 'Станислав Лем' }),
    ])
    render(<Loans go={() => {}} />)
    await screen.findByPlaceholderText('Название книги *')

    fireEvent.change(screen.getByPlaceholderText('Название книги *'), {
      target: { value: 'лем' },
    })
    expect(await screen.findByText(/Солярис/)).toBeTruthy()
    expect(screen.queryByText(/Мастер и Маргарита/)).toBeNull()
  })

  test('выбор из списка подставляет название и закрывает подсказку', async () => {
    vi.spyOn(api, 'myBooks').mockResolvedValue([book()])
    render(<Loans go={() => {}} />)

    await screen.findByPlaceholderText('Название книги *')
    fireEvent.change(screen.getByPlaceholderText('Название книги *'), { target: { value: 'мастер' } })
    fireEvent.click(await screen.findByText(/Мастер и Маргарита/))
    const input = screen.getByPlaceholderText('Название книги *') as HTMLInputElement
    expect(input.value).toBe('Мастер и Маргарита')
    await waitFor(() => expect(screen.queryByText(/С вашей полки/)).toBeNull())
  })

  test('выданную книгу не предлагаем, но объясняем почему её нет в списке', async () => {
    vi.spyOn(api, 'myBooks').mockResolvedValue([book({ status: 'busy' })])
    const { container } = render(<Loans go={() => {}} />)
    await waitFor(() => expect(screen.queryByText(/С вашей полки/)).toBeNull())

    fireEvent.change(screen.getByPlaceholderText('Название книги *'), {
      target: { value: 'мастер' },
    })
    // предложить её нельзя: выдача такой книги упирается в book_busy
    expect(container.querySelectorAll('.note .link-row').length).toBe(0)
    expect(screen.getByText(/уже на руках — сначала отметьте возврат/)).toBeTruthy()
  })

  test('длинная полка не выпихивает форму за экран: показываем пять и счётчик', async () => {
    vi.spyOn(api, 'myBooks').mockResolvedValue(
      Array.from({ length: 9 }, (_, i) => book({ id: `b${i}`, title: `Книга ${i}` })),
    )
    const { container } = render(<Loans go={() => {}} />)
    await screen.findByPlaceholderText('Название книги *')

    fireEvent.change(screen.getByPlaceholderText('Название книги *'), { target: { value: 'книга' } })
    await screen.findByText(/С вашей полки/)
    expect(container.querySelectorAll('.note .link-row').length).toBe(5)
    expect(screen.getByText(/и ещё 4 на полке/)).toBeTruthy()
  })

  test('регистр, ё и знаки препинания не мешают найти свою книгу', () => {
    expect(norm('Три товарища, ёжик!')).toBe('три товарища ежик')
    expect(bookMatches({ title: 'Ёжик в тумане', author: null }, norm('ежик'))).toBe(true)
    expect(bookMatches({ title: 'Солярис', author: 'Лем' }, norm('лем'))).toBe(true)
    expect(bookMatches({ title: 'Солярис', author: null }, norm('лем'))).toBe(false)
  })
})

/**
 * A1 (продуктовая команда 5.08.2026): читатель не закрывает выдачу. Во вкладке
 * «Я читаю» у него только информационное состояние, кнопки возврата нет.
 * Право проверяет сервер (см. loan-return-auth.test.ts), тут — что интерфейс
 * не показывает читателю действие.
 */
describe('A1: читатель не подтверждает возврат', () => {
  const mood = { level: 1, emoji: '📖', days: 3, label: 'читаю', overdueDays: 0 }

  test('во вкладке «Я читаю» нет кнопки возврата, только пояснение', async () => {
    vi.spyOn(api, 'myBooks').mockResolvedValue([])
    vi.spyOn(api, 'loans').mockResolvedValue({
      given: [],
      taken: [{ id: 'l1', title: 'Дюна', takenAt: '2026-08-01T00:00:00.000Z', mood }],
      history: [],
      summary: { given: 0, taken: 1, overdue: 0, mood: 'ok' as const, worst: null },
    } as any)
    render(<Loans go={() => {}} />)

    fireEvent.click(await screen.findByText(/Я читаю/))
    expect(await screen.findByText(/возврат отметит владелец/i)).toBeTruthy()
    expect(screen.queryByText(/Вернул\(а\) книгу/)).toBeNull()
  })

  test('у владельца во вкладке «На руках» действие возврата остаётся', async () => {
    vi.spyOn(api, 'myBooks').mockResolvedValue([])
    vi.spyOn(api, 'loans').mockResolvedValue({
      given: [{ id: 'g1', title: 'Солярис', holderUsername: 'reader', takenAt: '2026-08-01T00:00:00.000Z', mood }],
      taken: [],
      history: [],
      summary: { given: 1, taken: 0, overdue: 0, mood: 'ok' as const, worst: null },
    } as any)
    render(<Loans go={() => {}} />)

    expect(await screen.findByText(/Книга вернулась/)).toBeTruthy()
  })
})

/**
 * Просьба user 29.07.2026: «хочется иметь доступ ко всему списку, чтобы любую
 * книгу можно было выбрать, а не вводить вручную по памяти».
 */
describe('выбор книги из всей полки', () => {
  const shelf = (n: number) =>
    Array.from({ length: n }, (_, i) => book({ id: `b${i}`, title: `Книга ${i}`, author: null }))

  test('в списке вся полка, а не пять подсказок', async () => {
    vi.spyOn(api, 'myBooks').mockResolvedValue(shelf(9))
    const { container } = render(<Loans go={() => {}} />)

    fireEvent.click(await screen.findByText(/Выбрать из своей полки \(9\)/))
    expect(container.querySelectorAll('.sheet .pick-row').length).toBe(9)
  })

  test('выбор книги подставляет её в форму и закрывает список', async () => {
    vi.spyOn(api, 'myBooks').mockResolvedValue(shelf(9))
    const { container } = render(<Loans go={() => {}} />)
    fireEvent.click(await screen.findByText(/Выбрать из своей полки/))

    fireEvent.click(container.querySelectorAll('.sheet .pick-row')[3])
    const input = screen.getByPlaceholderText('Название книги *') as HTMLInputElement
    expect(input.value).toBe('Книга 3')
    await waitFor(() => expect(container.querySelector('.sheet')).toBeNull())
  })

  test('поиск внутри списка ищет и по автору', async () => {
    vi.spyOn(api, 'myBooks').mockResolvedValue([
      book(),
      book({ id: 'b2', title: 'Солярис', author: 'Станислав Лем' }),
    ])
    const { container } = render(<Loans go={() => {}} />)
    fireEvent.click(await screen.findByText(/Выбрать из своей полки/))

    fireEvent.change(screen.getByPlaceholderText('Поиск: название или автор…'), {
      target: { value: 'лем' },
    })
    const rows = container.querySelectorAll('.sheet .pick-row')
    expect(rows.length).toBe(1)
    expect(rows[0].textContent).toContain('Солярис')
  })

  test('книга на руках видна, но выбрать её нельзя', async () => {
    vi.spyOn(api, 'myBooks').mockResolvedValue([book({ status: 'busy' })])
    const { container } = render(<Loans go={() => {}} />)
    fireEvent.click(await screen.findByText(/Выбрать из своей полки/))

    const row = container.querySelector('.sheet .pick-row')!
    expect(row.tagName).not.toBe('BUTTON')
    expect(row.textContent).toContain('сначала отметьте возврат')
  })
})
