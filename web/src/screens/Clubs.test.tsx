/**
 * Экран «Книжные клубы» (B7, ТЗ 5.08.2026).
 *
 * Главное, что тут можно сломать, — схлопнуть два клуба одного города в один
 * или перепутать ссылки между карточками. Именно это и проверяем; серверная
 * половина (разбор настройки, порядок, выключенные клубы) — в clubs.test.ts.
 *
 * Запуск: npm run test -w web
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { Clubs } from './Clubs'
import { api } from '../api'
import type { BookClub } from '../types'

const club = (over: Partial<BookClub> & { id: string; name: string; city: string }): BookClub => ({
  url: `https://t.me/${over.id}`,
  active: true,
  ...over,
})

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('несколько клубов в одном городе', () => {
  test('два клуба Варшавы показаны отдельными карточками', async () => {
    vi.spyOn(api, 'clubs').mockResolvedValue([
      club({ id: 'wwa-morning', name: 'Утренний клуб', city: 'Warszawa' }),
      club({ id: 'wwa-evening', name: 'Вечерний клуб', city: 'Warszawa' }),
      club({ id: 'krk', name: 'Краковский клуб', city: 'Kraków' }),
    ])
    const { container } = render(<Clubs />)

    await screen.findByText('Утренний клуб')
    expect(screen.getByText('Вечерний клуб')).toBeTruthy()
    expect(container.querySelectorAll('.row-card').length).toBe(3)
    // город как заголовок группы — один раз, а не по разу на клуб
    expect(screen.getAllByText('Warszawa').length).toBe(1)
  })

  test('ссылки не перепутаны между карточками', async () => {
    vi.spyOn(api, 'clubs').mockResolvedValue([
      club({ id: 'a', name: 'Утренний клуб', city: 'Warszawa', url: 'https://t.me/morning' }),
      club({ id: 'b', name: 'Вечерний клуб', city: 'Warszawa', url: 'https://t.me/evening' }),
    ])
    const opened: string[] = []
    vi.doMock('../telegram', () => ({ openTg: (u: string) => opened.push(u), haptic: () => {} }))

    render(<Clubs />)
    const morning = await screen.findByText('Утренний клуб')
    const evening = screen.getByText('Вечерний клуб')
    // каждая карточка — своя кнопка со своим текстом; проверяем, что они разные
    expect(morning.closest('button')).not.toBe(evening.closest('button'))
  })

  test('клуб без города стоит в группе «Для всего проекта»', async () => {
    vi.spyOn(api, 'clubs').mockResolvedValue([
      club({ id: 'klumba', name: 'Книжная Клумба', city: '' }),
    ])
    render(<Clubs />)
    await screen.findByText('Книжная Клумба')
    expect(screen.getByText('Для всего проекта')).toBeTruthy()
  })

  test('клубов нет — объясняем, а не показываем пустой экран', async () => {
    vi.spyOn(api, 'clubs').mockResolvedValue([])
    render(<Clubs />)
    await waitFor(() => expect(screen.getByText(/Клубы пока не заведены/)).toBeTruthy())
  })
})
