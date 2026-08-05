/**
 * Витрина обложек: пустых карточек в ней быть не должно (A3, ТЗ 5.08.2026).
 *
 * Серверная половина (заглушка магазина «Brak zdjęcia», приходящая с кодом 200)
 * закрыта в server/src/cover-stub.test.ts. Здесь — то, что видит браузер:
 * книга без обложки, обложка, которая не загрузилась, и случай, когда не
 * осталось ни одной. Для списков заглушка допустима, для коверфлоу — нет:
 * дырка в ленте читается как поломка приложения.
 *
 * Запуск: npm run test -w web
 */
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { CoverCarousel, type CarouselBook } from './CoverCarousel'

vi.mock('../telegram', () => ({ haptic: () => {}, hapticSelection: () => {} }))

beforeAll(() => {
  // jsdom не реализует scrollTo у элементов (карусель подводит центр им же).
  // Это ограничение среды, а не поведение приложения — подменяем заглушкой.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
})

const book = (id: string, coverUrl: string): CarouselBook => ({ id, title: id, coverUrl })

const items = (container: HTMLElement) => container.querySelectorAll('.cc-item')

describe('карусель показывает только то, на что можно смотреть', () => {
  test('книга без обложки в ленту не попадает', () => {
    const { container } = render(
      <CoverCarousel
        books={[book('с обложкой', '/api/img?u=ok'), { id: 'без', title: 'без', coverUrl: '' }]}
        onOpen={() => {}}
      />,
    )
    expect(items(container).length).toBe(1)
  })

  test('не загрузившаяся обложка убирает карточку целиком, а не оставляет дырку', () => {
    const { container } = render(
      <CoverCarousel
        books={[book('живая', '/api/img?u=ok'), book('битая', '/api/img?u=dead')]}
        onOpen={() => {}}
      />,
    )
    expect(items(container).length).toBe(2)

    const dead = container.querySelectorAll('img')[1]
    fireEvent.error(dead)

    expect(items(container).length).toBe(1)
    expect(container.querySelector('.cc-item')?.getAttribute('aria-label')).toBe('живая')
  })

  test('повторная ошибка той же обложки не приводит к бесконечным попыткам', () => {
    const { container } = render(
      <CoverCarousel books={[book('живая', '/ok'), book('битая', '/dead')]} onOpen={() => {}} />,
    )
    const dead = container.querySelectorAll('img')[1]
    fireEvent.error(dead)
    fireEvent.error(dead) // повтор — состояние уже не меняется, карточки не возвращаются
    expect(items(container).length).toBe(1)
  })

  test('если валидных обложек не осталось — карусели нет вовсе', () => {
    const { container } = render(
      <CoverCarousel books={[book('битая', '/dead')]} onOpen={() => {}} />,
    )
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('.cover-carousel')).toBeNull()
  })

  test('пустой список книг не рисует пустую полосу', () => {
    const { container } = render(<CoverCarousel books={[]} onOpen={() => {}} />)
    expect(container.querySelector('.cover-carousel')).toBeNull()
  })
})
