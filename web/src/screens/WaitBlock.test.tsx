/**
 * Очередь на занятую книгу в карточке (issue #10).
 *
 * Проверяется то, что ломается тише всего: блок не появляется там, где ждать
 * нечего; человек видит СВОЁ место и не видит соседей; отказы сервера доходят
 * до него человеческим языком, а не кодом.
 *
 * Запуск: npm run test -w web
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { WaitBlock } from './WaitBlock'
import { api } from '../api'
import type { Book, Waitlist } from '../types'

const book = (over: Partial<Book> = {}): Book => ({
  id: 'b1',
  kind: 'book',
  title: 'Дюна',
  author: 'Герберт',
  genres: [],
  languages: [],
  city: 'Warszawa',
  district: null,
  coverUrl: null,
  status: 'busy',
  source: 'notion',
  owner: null,
  ...over,
})

const waitlist = (over: Partial<Waitlist> = {}): Waitlist => ({ count: 0, mine: null, ...over })

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('очередь на занятую книгу', () => {
  test('у свободной книги блока нет: ждать нечего, надо просто написать владельцу', () => {
    const { container } = render(<WaitBlock book={book({ status: 'free' })} />)
    expect(container.textContent).toBe('')
  })

  test('у занятой книги предлагаем сообщить, когда освободится', () => {
    render(<WaitBlock book={book({ waiting: waitlist() })} />)
    expect(screen.getByText('Сейчас на руках')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Сообщить, когда освободится/ })).toBeTruthy()
  })

  test('видно, сколько человек уже ждёт, но не кто именно', () => {
    render(<WaitBlock book={book({ waiting: waitlist({ count: 3 }) })} />)
    expect(screen.getByText('Уже ждут: 3')).toBeTruthy()
  })

  test('своё место в очереди показывается, и из неё можно выйти', async () => {
    const join = vi
      .spyOn(api, 'wait')
      .mockResolvedValue({ waiting: waitlist({ count: 2, mine: { position: 2, status: 'waiting' } }) })
    render(<WaitBlock book={book({ waiting: waitlist({ count: 1 }) })} />)

    fireEvent.click(screen.getByRole('button', { name: /Сообщить, когда освободится/ }))
    await waitFor(() => expect(screen.getByText('Вы 2-й в очереди из 2')).toBeTruthy())
    expect(join).toHaveBeenCalledWith('b1')

    const leave = vi.spyOn(api, 'unwait').mockResolvedValue({ waiting: waitlist() })
    fireEvent.click(screen.getByRole('button', { name: /Не ждать/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Сообщить, когда освободится/ })).toBeTruthy())
    expect(leave).toHaveBeenCalledWith('b1')
  })

  test('позванному первым говорим прямо: книга освободилась, пишите владельцу', () => {
    render(
      <WaitBlock book={book({ status: 'free', waiting: waitlist({ count: 1, mine: { position: 1, status: 'ready' } }) })} />,
    )
    expect(screen.getByText('Книга освободилась')).toBeTruthy()
    expect(screen.getByText('Напишите владельцу, пока её не взяли')).toBeTruthy()
  })

  test('владельцу объясняем словами, а не кодом own_book', async () => {
    vi.spyOn(api, 'wait').mockRejectedValue(new Error('own_book'))
    render(<WaitBlock book={book({ waiting: waitlist() })} />)

    fireEvent.click(screen.getByRole('button', { name: /Сообщить, когда освободится/ }))
    await waitFor(() =>
      expect(screen.getByText('Это ваша книга — вы и так узнаете, когда её вернут.')).toBeTruthy(),
    )
  })

  test('книга успела освободиться, пока человек читал карточку', async () => {
    vi.spyOn(api, 'wait').mockRejectedValue(new Error('not_busy'))
    render(<WaitBlock book={book({ waiting: waitlist() })} />)

    fireEvent.click(screen.getByRole('button', { name: /Сообщить, когда освободится/ }))
    await waitFor(() =>
      expect(screen.getByText('Книга уже свободна: напишите владельцу напрямую.')).toBeTruthy(),
    )
  })

  test('стоящему в очереди на освободившуюся книгу блок всё ещё виден: из очереди надо уметь выйти', () => {
    render(
      <WaitBlock book={book({ status: 'free', waiting: waitlist({ count: 1, mine: { position: 1, status: 'waiting' } }) })} />,
    )
    expect(screen.getByText('Книга снова на полке')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Не ждать/ })).toBeTruthy()
  })
})
