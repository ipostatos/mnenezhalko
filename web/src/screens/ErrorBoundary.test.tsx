/**
 * Белый экран вместо приложения (внешний аудит 30.07.2026): любая ошибка
 * отрисовки роняла Mini App целиком, и человек видел пустоту без объяснений.
 *
 * Запуск: npm run test -w web
 */
import { describe, expect, test, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'

function Broken(): JSX.Element {
  throw new Error('экран не собрался')
}

afterEach(() => vi.restoreAllMocks())

describe('заглушка вместо белого экрана', () => {
  test('упавший экран заменяется объяснением, а не пустотой', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Приложение не открылось')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Открыть заново' })).toBeTruthy()
    // человеку нужно чем-то назвать свой случай в чате
    expect(screen.getByText(/[A-Z0-9]{4}-[A-Z0-9]{3}/)).toBeTruthy()
  })

  test('пока всё цело, заглушка не мешает', () => {
    render(
      <ErrorBoundary>
        <div>Моя полка</div>
      </ErrorBoundary>,
    )
    expect(screen.getByText('Моя полка')).toBeTruthy()
    expect(screen.queryByText('Приложение не открылось')).toBeNull()
  })
})
