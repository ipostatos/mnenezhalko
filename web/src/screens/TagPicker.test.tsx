/**
 * Выбор жанра и языка из справочника проекта (просьба user 29.07.2026:
 * «редактирование жанров и языка лучше выбирать из списка, иначе люди могут
 * наделать делов… используем только жанры из ноушена, новые не добавляем»).
 *
 * Проверяем главное: своего значения здесь не завести, длинный справочник
 * доступен целиком, а старый жанр книги, которого в справочнике уже нет, виден
 * и его можно снять.
 *
 * Запуск: npm run test -w web
 */
import { describe, expect, test, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TagPicker } from './TagPicker'
import { countLabel } from './Library'

const GENRES = Array.from({ length: 40 }, (_, i) => `Жанр ${i}`)

describe('выбор из справочника', () => {
  test('свободного ввода нет: только кнопки вариантов и поиск по ним', () => {
    const { container } = render(<TagPicker options={['Фентези']} value={[]} onChange={() => {}} />)
    // короткий справочник — вообще без полей ввода
    expect(container.querySelectorAll('input').length).toBe(0)
    expect(screen.getByRole('button', { name: 'Фентези' })).toBeTruthy()
  })

  test('длинный справочник доступен целиком — через «ещё N» и поиск', () => {
    const { container } = render(<TagPicker options={GENRES} value={[]} onChange={() => {}} />)
    expect(container.querySelectorAll('.chips .chip').length).toBeLessThan(GENRES.length)

    fireEvent.click(screen.getByRole('button', { name: /ещё 24/ }))
    expect(container.querySelectorAll('.chips .chip').length).toBe(GENRES.length)
  })

  test('поиск находит вариант, которого не видно в первом экране', () => {
    render(<TagPicker options={GENRES} value={[]} onChange={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Найти в списке…'), { target: { value: 'жанр 39' } })
    expect(screen.getByRole('button', { name: 'Жанр 39' })).toBeTruthy()
  })

  test('чего нет в справочнике — не завести, и это объясняется', () => {
    render(<TagPicker options={GENRES} value={[]} onChange={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Найти в списке…'), {
      target: { value: 'мой особенный жанр' },
    })
    expect(screen.getByText(/Новые значения заводят администраторы/)).toBeTruthy()
  })

  test('старое значение книги видно и снимается, хотя в справочнике его нет', () => {
    const onChange = vi.fn()
    render(<TagPicker options={['Фентези']} value={['Художка']} onChange={onChange} />)

    const legacy = screen.getByRole('button', { name: 'Художка' })
    expect(legacy.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(legacy)
    expect(onChange).toHaveBeenCalledWith([])
  })

  test('больше максимума не выбрать', () => {
    const onChange = vi.fn()
    render(
      <TagPicker options={['A', 'B', 'C']} value={['A', 'B']} onChange={onChange} max={2} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'C' }))
    expect(onChange).not.toHaveBeenCalled()
    // снять выбранное при этом можно — иначе из ограничения не выйти
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    expect(onChange).toHaveBeenCalledWith(['B'])
  })
})

/** Жалоба user: «а то не понятно что за цифра сверху». */
describe('подпись счётчика в Библиотеке', () => {
  test('с фильтром города считается город и так и написано', () => {
    expect(countLabel(322, 'book', 'Warszawa')).toBe('322 книги на полках вашего города (Warszawa)')
  })

  test('без фильтра честно сказано, что это весь проект', () => {
    expect(countLabel(3249, 'book')).toBe('3249 книг на полках во всех городах проекта')
  })

  test('настолки считаются настолками', () => {
    expect(countLabel(12, 'game', 'Kraków')).toBe('12 игр на полках вашего города (Kraków)')
  })
})
