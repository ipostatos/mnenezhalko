/**
 * Экран разбора для админов.
 *
 * Проверяется то, из-за чего экран вообще делался: по карточке видно, ЧТО
 * решаем (название, чья книга, город, сколько ждёт), решение уходит той же
 * ручкой, что и кнопка в боте, и — главное — отказ без причины отправить
 * нельзя: причину читает человек, которому отказали.
 *
 * Запуск: npm run test -w web
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { Admin } from './Admin'
import { Home } from './Home'
import { api } from '../api'
import type { ModerationQueue, Me, PendingBook, QueueReview } from '../types'

const pendingBook = (over: Partial<PendingBook> & { title: string }): PendingBook => ({
  id: over.title,
  author: 'Автор',
  kind: 'book',
  coverUrl: null,
  ownerName: 'Ирина',
  city: 'Warszawa',
  genres: ['Фантастика'],
  languages: ['Русский'],
  source: 'bot',
  notionStatus: 'pending',
  submittedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  ...over,
})

const queueReview = (over: Partial<QueueReview> = {}): QueueReview => ({
  id: 'r1',
  workKey: 'мастер и маргарита|булгаков',
  rating: 2,
  text: 'Возмутительный отзыв',
  status: 'visible',
  authorTg: '990010',
  authorName: 'Пётр',
  reports: 3,
  reportedAt: [],
  hiddenAt: null,
  history: [],
  ...over,
})

const emptyQueue = (over: Partial<ModerationQueue> = {}): ModerationQueue => ({
  reviews: [],
  pendingBooks: [],
  pendingBooksCount: 0,
  stuckNotices: 0,
  restrictions: [],
  banned: [],
  recent: [],
  ...over,
})

const me = (isAdmin: boolean): Me => ({
  user: { tgId: '1', username: 'u', firstName: 'Имя', city: 'Warszawa', isAdmin },
  librarian: null,
})

beforeEach(() => {
  vi.restoreAllMocks()
  // вне Telegram showAlert падает в window.alert, которого в jsdom нет
  vi.spyOn(window, 'alert').mockImplementation(() => {})
})

describe('плашка разбора на главной', () => {
  test('админ видит её, обычный участник — нет', () => {
    vi.spyOn(api, 'impact').mockRejectedValue(new Error('нет данных'))
    const { rerender } = render(<Home go={() => {}} me={me(false)} health={null} loans={null} />)
    expect(screen.queryByText('Разбор')).toBeNull()

    rerender(<Home go={() => {}} me={me(true)} health={null} loans={null} />)
    expect(screen.getByText('Разбор')).toBeTruthy()
  })
})

describe('книги на проверке', () => {
  test('в карточке видно, что решаем: книга, чья, город, сколько ждёт', async () => {
    vi.spyOn(api, 'moderationQueue').mockResolvedValue(
      emptyQueue({ pendingBooks: [pendingBook({ title: 'Тайна' })], pendingBooksCount: 1 }),
    )
    render(<Admin />)
    await screen.findByText('Тайна')

    expect(screen.getByText(/Ирина/)).toBeTruthy()
    expect(screen.getByText(/Warszawa/)).toBeTruthy()
    expect(screen.getByText('Фантастика')).toBeTruthy()
    // «сколько ждёт» — по этому и выбирают, чем заняться первым
    expect(screen.getByText(/Ждёт: 2 дня/)).toBeTruthy()
  })

  test('«Одобрить» уходит той же ручкой, что кнопка в боте, и список обновляется', async () => {
    const decide = vi.spyOn(api, 'decideBook').mockResolvedValue({ ok: true, card: {} } as any)
    const queue = vi
      .spyOn(api, 'moderationQueue')
      .mockResolvedValueOnce(
        emptyQueue({ pendingBooks: [pendingBook({ title: 'Тайна' })], pendingBooksCount: 1 }),
      )
      .mockResolvedValue(emptyQueue())

    render(<Admin />)
    await screen.findByText('Тайна')
    fireEvent.click(screen.getByText(/Одобрить/))

    await waitFor(() => expect(decide).toHaveBeenCalledWith('Тайна', 'approve'))
    // очередь перечитывается: одобренная книга исчезает без перезахода в экран
    await waitFor(() => expect(queue).toHaveBeenCalledTimes(2))
    await screen.findByText(/Книг на проверке нет/)
  })

  test('отказ без причины отправить нельзя — её увидит человек', async () => {
    const decide = vi.spyOn(api, 'decideBook').mockResolvedValue({ ok: true, card: {} } as any)
    vi.spyOn(api, 'moderationQueue').mockResolvedValue(
      emptyQueue({ pendingBooks: [pendingBook({ title: 'Тайна' })], pendingBooksCount: 1 }),
    )

    render(<Admin />)
    await screen.findByText('Тайна')
    fireEvent.click(screen.getByText(/Отклонить/))

    const send = screen.getByText('Отправить отказ') as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.click(send)
    expect(decide).not.toHaveBeenCalled()

    fireEvent.change(screen.getByPlaceholderText(/Причина отказа/), {
      target: { value: 'фото не читается' },
    })
    expect((screen.getByText('Отправить отказ') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByText('Отправить отказ'))
    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith('Тайна', 'reject', 'фото не читается'),
    )
  })
})

describe('отзывы и люди', () => {
  test('у отзыва с жалобами есть и «скрыть», и «жалобы напрасны»', async () => {
    vi.spyOn(api, 'moderationQueue').mockResolvedValue(emptyQueue({ reviews: [queueReview()] }))
    render(<Admin />)
    await screen.findByText(/Отзывы/)
    fireEvent.click(screen.getByText(/Отзывы/))

    expect(screen.getByText('Возмутительный отзыв')).toBeTruthy()
    expect(screen.getByText(/Уникальных жалоб: 3/)).toBeTruthy()
    expect(screen.getByText(/Скрыть/)).toBeTruthy()
    expect(screen.getByText('Жалобы напрасны')).toBeTruthy()
  })

  test('скрытие требует причину и уходит с ней', async () => {
    const decide = vi.spyOn(api, 'decideReview').mockResolvedValue({ ok: true } as any)
    vi.spyOn(api, 'moderationQueue').mockResolvedValue(emptyQueue({ reviews: [queueReview()] }))
    render(<Admin />)
    fireEvent.click(await screen.findByText(/Отзывы/))
    fireEvent.click(screen.getByText(/Скрыть/))

    fireEvent.change(screen.getByPlaceholderText(/Почему скрываем/), {
      target: { value: 'оскорбления' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Скрыть' }))
    await waitFor(() => expect(decide).toHaveBeenCalledWith('r1', 'hide', 'оскорбления'))
  })

  test('ограничение читается словами, а не кодом области', async () => {
    vi.spyOn(api, 'moderationQueue').mockResolvedValue(
      emptyQueue({
        restrictions: [
          {
            id: 'x1',
            userTg: '990010',
            name: 'Пётр',
            username: 'reader',
            scope: 'reviews',
            reason: 'ругань',
            createdAt: new Date().toISOString(),
            expiresAt: null,
          },
        ],
      }),
    )
    render(<Admin />)
    fireEvent.click(await screen.findByText(/Люди/))

    expect(screen.getByText('Пётр')).toBeTruthy()
    expect(screen.getByText(/оценки и отзывы/)).toBeTruthy()
    expect(screen.getByText(/бессрочно/)).toBeTruthy()
  })
})

describe('честность экрана', () => {
  test('недоставленные письма показаны наверху: человек не узнал о решении', async () => {
    vi.spyOn(api, 'moderationQueue').mockResolvedValue(emptyQueue({ stuckNotices: 2 }))
    render(<Admin />)
    expect(await screen.findByText(/2 письма о решениях не дошло до людей/)).toBeTruthy()
  })

  test('неадмину экран объясняет отказ по-русски, а не кодом', async () => {
    vi.spyOn(api, 'moderationQueue').mockRejectedValue(new Error('forbidden'))
    render(<Admin />)
    expect(await screen.findByText('Этот раздел только для админов.')).toBeTruthy()
  })
})
