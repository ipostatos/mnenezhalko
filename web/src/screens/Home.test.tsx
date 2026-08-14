/**
 * Плашка «часть действий закрыта» на главной (аудит 14.08.2026).
 *
 * Сервер отдаёт ограничения и бан в `/api/me` с самого начала, но клиентский
 * тип их отбрасывал: заблокированному приложение выглядело полностью рабочим,
 * и он узнавал о запрете, только упёршись в него.
 *
 * Запуск: npm run test -w web
 */
import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Home } from './Home'
import type { Me } from '../types'

const me = (over: Partial<Me> = {}): Me => ({
  user: { tgId: '1', username: 'reader', firstName: 'Читатель', city: 'Warszawa', isAdmin: false },
  librarian: null,
  ...over,
})

const renderHome = (m: Me | null) =>
  render(<Home go={() => {}} me={m} health={null} loans={null} />)

describe('главная объясняет ограничения', () => {
  test('без ограничений плашки нет', () => {
    renderHome(me())
    expect(screen.queryByRole('status')).toBeNull()
  })

  test('ограничение названо словами, с причиной и сроком', () => {
    renderHome(
      me({ restrictions: [{ scope: 'reviews', reason: 'спам в отзывах', until: '2026-08-20T00:00:00.000Z' }] }),
    )
    const notice = screen.getByRole('status')
    expect(notice.textContent).toContain('Оценки и отзывы')
    expect(notice.textContent).toContain('спам в отзывах')
    expect(notice.textContent).toContain('20.08.2026')
  })

  test('бессрочное ограничение так и называется', () => {
    renderHome(me({ restrictions: [{ scope: 'add_books', reason: 'разбираемся', until: null }] }))
    expect(screen.getByRole('status').textContent).toContain('бессрочно')
  })

  test('заблокированному видно причину и путь к своим данным', () => {
    renderHome(me({ banned: true, banReason: 'реклама в чате' }))
    const notice = screen.getByRole('status')
    expect(notice.textContent).toContain('Доступ к проекту закрыт')
    expect(notice.textContent).toContain('реклама в чате')
    expect(notice.textContent).toContain('Ваши данные')
  })
})
