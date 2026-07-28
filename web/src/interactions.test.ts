/**
 * P1.3 аудита 2026-07-28: мобильные взаимодействия Mini App.
 * Запуск: npm run test -w web (vitest)
 */
import { describe, expect, test } from 'vitest'
import { shouldSuppressDoubleTap } from './telegram'
import { warsawDay } from './dates'

/** Мини-заглушка Element: глушителю нужен только closest(). */
const el = (interactive: boolean) =>
  ({ closest: (_sel: string) => (interactive ? {} : null) }) as unknown as Element

describe('глушитель двойного тапа', () => {
  test('быстрый повторный тап по кнопке/чипу НЕ гасится — люди тапают быстро', () => {
    expect(shouldSuppressDoubleTap(100, el(true))).toBe(false)
  })

  test('быстрый повторный тап по пустому месту гасится (зум страницы)', () => {
    expect(shouldSuppressDoubleTap(100, el(false))).toBe(true)
  })

  test('медленный тап не гасится нигде', () => {
    expect(shouldSuppressDoubleTap(500, el(false))).toBe(false)
    expect(shouldSuppressDoubleTap(500, el(true))).toBe(false)
  })

  test('target без closest (текстовый узел, null) — гасим как пустое место', () => {
    expect(shouldSuppressDoubleTap(100, null)).toBe(true)
  })
})

describe('локальная дата выдачи (Europe/Warsaw)', () => {
  test('ночь по Варшаве: 23:30 UTC 31 июля = уже 1 августа по Польше (лето, +2)', () => {
    expect(warsawDay(new Date('2026-07-31T23:30:00Z'))).toBe('2026-08-01')
  })

  test('зима (+1): 23:30 UTC — уже следующий день', () => {
    expect(warsawDay(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01')
  })

  test('обычный день совпадает с UTC-днём', () => {
    expect(warsawDay(new Date('2026-07-15T12:00:00Z'))).toBe('2026-07-15')
  })
})
