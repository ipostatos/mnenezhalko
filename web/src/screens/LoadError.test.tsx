/**
 * «Не загрузилось» вместо «у вас ничего нет» (аудит 14.08.2026).
 *
 * На семи экранах отказ сети гасился пустым обработчиком, и человек в метро
 * читал «Пока пусто» — приложение утверждало, что его выдач, книг и встреч не
 * существует. Здесь проверяем на живых экранах: при отказе виден текст ошибки и
 * кнопка повтора, а при честном пустом ответе — прежняя дружелюбная пустота.
 *
 * Запуск: npm run test -w web
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { Clubs } from './Clubs'
import { Market } from './Market'
import { Events } from './Events'
import { Loans } from './Loans'
import { api } from '../api'

beforeEach(() => {
  vi.restoreAllMocks()
})

const offline = () => Promise.reject(new Error('Failed to fetch'))

describe('отказ сети отличается от пустого ответа', () => {
  test('клубы: ошибка и повтор вместо тишины', async () => {
    const spy = vi.spyOn(api, 'clubs').mockImplementation(offline)
    render(<Clubs />)

    await screen.findByRole('alert')
    const retry = screen.getByRole('button', { name: /Попробовать ещё раз/ })
    spy.mockResolvedValue([])
    fireEvent.click(retry)

    // повтор действительно перезапрашивает и показывает честную пустоту
    await screen.findByText(/Клубы пока не заведены/)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  test('барахолка: «Пока пусто — будьте первым» не показывается при отказе', async () => {
    vi.spyOn(api, 'market').mockImplementation(offline)
    render(<Market city="Warszawa" />)

    await screen.findByRole('alert')
    expect(screen.queryByText(/будьте первым/)).toBeNull()
  })

  test('встречи: «встреч пока нет» не показывается при отказе', async () => {
    vi.spyOn(api, 'events').mockImplementation(offline)
    render(<Events city="Warszawa" me={null} />)

    await screen.findByRole('alert')
    expect(screen.queryByText(/Ближайших встреч пока нет/)).toBeNull()
  })

  test('выдачи: «Пока пусто» не показывается при отказе', async () => {
    vi.spyOn(api, 'loans').mockImplementation(offline)
    vi.spyOn(api, 'myBooks').mockResolvedValue([])
    render(<Loans go={() => {}} />)

    await screen.findByRole('alert')
    expect(screen.queryByText(/Пока пусто/)).toBeNull()
  })

  test('честный пустой ответ по-прежнему выглядит дружелюбно, а не ошибкой', async () => {
    vi.spyOn(api, 'loans').mockResolvedValue({
      given: [],
      taken: [],
      history: [],
      summary: { active: 0, overdue: 0, longestDays: 0, longestTitle: null, mood: null },
    } as any)
    vi.spyOn(api, 'myBooks').mockResolvedValue([])
    render(<Loans go={() => {}} />)

    await screen.findByText(/Пока пусто/)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})
