/**
 * Экран «Встречи»: афиша и админский блок уборки прошедших.
 *
 * Проверяется то, что легко сломать незаметно: обычный участник блока не видит
 * и запроса за прошедшими не делает, отказ в подтверждении ничего не убирает,
 * а убранная встреча пропадает со экрана без перезагрузки.
 *
 * Сам жест свайпа здесь не проверяется (это указатели и трансформации, их
 * место — живой Telegram): кнопка корзины доступна и без жеста, как и должна
 * быть — иначе экран нельзя было бы использовать с клавиатуры.
 *
 * Запуск: npm run test -w web
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { Events } from './Events'
import { api } from '../api'
import type { EventItem, Me } from '../types'

const me = (isAdmin: boolean): Me => ({
  user: { tgId: '1', username: 'u', firstName: 'Имя', city: 'Warszawa', isAdmin },
  librarian: null,
})

const event = (over: Partial<EventItem> = {}): EventItem => ({
  id: 'e1',
  city: 'Warszawa',
  title: 'Книжный обмен',
  startsAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  place: 'Кафе',
  description: null,
  url: null,
  ...over,
})

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(api, 'events').mockResolvedValue([])
})

describe('блок прошедших встреч', () => {
  test('обычный участник его не видит и за прошедшими не ходит', async () => {
    const past = vi.spyOn(api, 'pastEvents').mockResolvedValue([event()])
    render(<Events city="Warszawa" me={me(false)} />)
    await waitFor(() => expect(api.events).toHaveBeenCalled())
    expect(screen.queryByText(/Прошедшие/)).toBeNull()
    expect(past).not.toHaveBeenCalled()
  })

  test('админ видит блок со счётчиком и подсказкой про свайп', async () => {
    vi.spyOn(api, 'pastEvents').mockResolvedValue([event(), event({ id: 'e2' })])
    render(<Events city="Warszawa" me={me(true)} />)
    await waitFor(() => expect(screen.getByText(/Прошедшие · 2 встречи/)).toBeTruthy())
    expect(screen.getByText(/Свайп влево/)).toBeTruthy()
  })

  test('пустой список прошедших блока не рисует', async () => {
    vi.spyOn(api, 'pastEvents').mockResolvedValue([])
    render(<Events city="Warszawa" me={me(true)} />)
    await waitFor(() => expect(api.pastEvents).toHaveBeenCalled())
    expect(screen.queryByText(/Прошедшие/)).toBeNull()
  })
})

describe('уборка встречи', () => {
  test('отказ в подтверждении ничего не убирает', async () => {
    vi.spyOn(api, 'pastEvents').mockResolvedValue([event()])
    const remove = vi.spyOn(api, 'removeEvent')
    vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<Events city="Warszawa" me={me(true)} />)
    await waitFor(() => expect(screen.getByText(/Прошедшие/)).toBeTruthy())
    fireEvent.click(screen.getByLabelText(/Убрать «Книжный обмен»/))

    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect(remove).not.toHaveBeenCalled()
    expect(screen.getByText('Книжный обмен')).toBeTruthy()
  })

  test('подтверждение убирает встречу с экрана', async () => {
    vi.spyOn(api, 'pastEvents').mockResolvedValue([event(), event({ id: 'e2', title: 'Клумба' })])
    vi.spyOn(api, 'removeEvent').mockResolvedValue({ ok: true, id: 'e1' })
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<Events city="Warszawa" me={me(true)} />)
    await waitFor(() => expect(screen.getByText(/Прошедшие · 2/)).toBeTruthy())
    fireEvent.click(screen.getByLabelText(/Убрать «Книжный обмен»/))

    await waitFor(() => expect(screen.queryByText('Книжный обмен')).toBeNull())
    expect(api.removeEvent).toHaveBeenCalledWith('e1')
    // соседняя встреча на месте, счётчик пересчитан — без перезагрузки экрана
    expect(screen.getByText('Клумба')).toBeTruthy()
    expect(screen.getByText(/Прошедшие · 1 встреча/)).toBeTruthy()
  })

  test('в подтверждении названа встреча и сказано, что будет с чатом', async () => {
    vi.spyOn(api, 'pastEvents').mockResolvedValue([event()])
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<Events city="Warszawa" me={me(true)} />)
    await waitFor(() => expect(screen.getByText(/Прошедшие/)).toBeTruthy())
    fireEvent.click(screen.getByLabelText(/Убрать «Книжный обмен»/))

    await waitFor(() => expect(confirm).toHaveBeenCalled())
    const text = confirm.mock.calls[0][0] as string
    expect(text).toMatch(/Книжный обмен/)
    expect(text).toMatch(/пропадёт из афиши/)
    expect(text).toMatch(/чате останется/)
  })

  test('сбой ручки не оставляет экран врать: список перечитывается', async () => {
    vi.spyOn(api, 'pastEvents').mockResolvedValue([event()])
    vi.spyOn(api, 'removeEvent').mockRejectedValue(new Error('409'))
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<Events city="Warszawa" me={me(true)} />)
    await waitFor(() => expect(screen.getByText(/Прошедшие/)).toBeTruthy())
    fireEvent.click(screen.getByLabelText(/Убрать «Книжный обмен»/))

    await waitFor(() => expect(api.pastEvents).toHaveBeenCalledTimes(2))
    expect(screen.getByText('Книжный обмен')).toBeTruthy()
  })
})
