/**
 * Экран отзывов (issue #18) — первые тесты интерфейса Mini App.
 *
 * Почему именно они: до сих пор роботом проверялся только сервер, и регрессия
 * 27 июля (в «Библиотеке» пропали обложки) прожила два дня, потому что ловить
 * её было нечем. Здесь проверяется поведение, которое ломается тише всего:
 * кому показывается форма оценки, что уходит на сервер и как выглядит ошибка.
 *
 * Запуск: npm run test -w web
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { Reviews } from './Reviews'
import { api } from '../api'
import type { ReviewsPayload } from '../types'

const payload = (over: Partial<ReviewsPayload> = {}): ReviewsPayload => ({
  rating: { avg: 4.5, count: 2 },
  items: [
    {
      id: 'r1',
      rating: 5,
      text: 'Читается за вечер',
      authorName: 'Аня',
      mine: false,
      createdAt: '2026-07-28T10:00:00.000Z',
    },
  ],
  signed: true,
  canReview: false,
  myReview: null,
  textMax: 300,
  ...over,
})

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('оценки и аннотации в карточке книги', () => {
  test('средняя, число оценок и чужой отзыв видны всем', async () => {
    vi.spyOn(api, 'reviews').mockResolvedValue(payload())
    render(<Reviews bookId="b1" />)

    expect(await screen.findByText('4.5')).toBeTruthy()
    expect(screen.getByText('2 оценки')).toBeTruthy()
    expect(screen.getByText('Читается за вечер')).toBeTruthy()
    expect(screen.getByText('Аня')).toBeTruthy()
  })

  test('не читавшему форму не показываем — оценку ставит тот, кто держал книгу', async () => {
    vi.spyOn(api, 'reviews').mockResolvedValue(payload())
    render(<Reviews bookId="b1" />)

    await screen.findByText('4.5')
    expect(screen.queryByRole('button', { name: 'Оценка 5 из 5' })).toBeNull()
    expect(screen.queryByText('Оценить книгу')).toBeNull()
  })

  test('читавшему показываем звёзды, и до выбора оценки кнопка выключена', async () => {
    vi.spyOn(api, 'reviews').mockResolvedValue(payload({ canReview: true }))
    render(<Reviews bookId="b1" />)

    const save = (await screen.findByText('Оценить книгу')) as HTMLButtonElement
    expect(save.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Оценка 4 из 5' }))
    expect((screen.getByText('Оценить книгу') as HTMLButtonElement).disabled).toBe(false)
  })

  test('оценка с текстом уходит на сервер и экран показывает благодарность', async () => {
    vi.spyOn(api, 'reviews').mockResolvedValue(payload({ canReview: true }))
    const save = vi.spyOn(api, 'saveReview').mockResolvedValue({
      rating: { avg: 5, count: 1 },
      items: [
        {
          id: 'mine',
          rating: 5,
          text: 'Отличная книга',
          authorName: 'Вы',
          mine: true,
          createdAt: '2026-07-29T10:00:00.000Z',
        },
      ],
    })

    render(<Reviews bookId="b1" />)
    await screen.findByText('Оценить книгу')

    fireEvent.click(screen.getByRole('button', { name: 'Оценка 5 из 5' }))
    fireEvent.change(screen.getByPlaceholderText(/Пара слов о книге/), {
      target: { value: 'Отличная книга' },
    })
    fireEvent.click(screen.getByText('Оценить книгу'))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('b1', { rating: 5, text: 'Отличная книга' }),
    )
    expect(await screen.findByText('Спасибо, записал.')).toBeTruthy()
    // после сохранения форма превращается в редактирование своей оценки
    expect(await screen.findByText('Обновить оценку')).toBeTruthy()
    expect(screen.getByText('Удалить мою оценку')).toBeTruthy()
  })

  test('ссылку в отзыве сервер не принимает — человек видит понятную причину', async () => {
    vi.spyOn(api, 'reviews').mockResolvedValue(payload({ canReview: true }))
    vi.spyOn(api, 'saveReview').mockRejectedValue(new Error('links_not_allowed'))

    render(<Reviews bookId="b1" />)
    await screen.findByText('Оценить книгу')
    fireEvent.click(screen.getByRole('button', { name: 'Оценка 3 из 5' }))
    fireEvent.click(screen.getByText('Оценить книгу'))

    expect(await screen.findByText('Ссылки в отзывах не публикуем — уберите ссылку.')).toBeTruthy()
    expect(screen.queryByText('Спасибо, записал.')).toBeNull()
  })

  test('удаление своей оценки очищает форму и среднюю', async () => {
    vi.spyOn(api, 'reviews').mockResolvedValue(
      payload({
        canReview: true,
        rating: { avg: 5, count: 1 },
        items: [
          {
            id: 'mine',
            rating: 5,
            text: 'Моя аннотация',
            authorName: 'Вы',
            mine: true,
            createdAt: '2026-07-29T10:00:00.000Z',
          },
        ],
        myReview: {
          id: 'mine',
          rating: 5,
          text: 'Моя аннотация',
          authorName: 'Вы',
          mine: true,
          createdAt: '2026-07-29T10:00:00.000Z',
        },
      }),
    )
    const del = vi
      .spyOn(api, 'deleteReview')
      .mockResolvedValue({ rating: { avg: null, count: 0 }, items: [] })

    render(<Reviews bookId="b1" />)
    fireEvent.click(await screen.findByText('Удалить мою оценку'))

    await waitFor(() => expect(del).toHaveBeenCalledWith('b1'))
    expect(await screen.findByText(/Эту книгу ещё никто не оценил/)).toBeTruthy()
    expect(screen.queryByText('Моя аннотация')).toBeNull()
  })

  test('жалоба убирает чужой отзыв с экрана', async () => {
    vi.spyOn(api, 'reviews').mockResolvedValue(payload())
    const report = vi.spyOn(api, 'reportReview').mockResolvedValue({ hidden: false, reports: 1 })

    render(<Reviews bookId="b1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Пожаловаться на отзыв' }))

    await waitFor(() => expect(report).toHaveBeenCalledWith('r1'))
    await waitFor(() => expect(screen.queryByText('Читается за вечер')).toBeNull())
  })

  test('гостю без подписи Telegram кнопку «пожаловаться» не показываем: она ответила бы 401', async () => {
    vi.spyOn(api, 'reviews').mockResolvedValue(payload({ signed: false }))
    render(<Reviews bookId="b1" />)

    expect(await screen.findByText('Читается за вечер')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Пожаловаться на отзыв' })).toBeNull()
  })

  test('упавшая ручка отзывов не ломает карточку книги: блок просто не рисуется', async () => {
    vi.spyOn(api, 'reviews').mockRejectedValue(new Error('HTTP 500'))
    const { container } = render(<Reviews bookId="b1" />)
    await waitFor(() => expect(container.textContent).toBe(''))
  })
})
