/**
 * Ошибка ручки доезжает до человека словами, а не кодом (аудит 14.08.2026).
 *
 * Сервер специально собирает объяснение («что закрыто, почему, до какого
 * числа») и кладёт его в поле `message`, а клиент читал только `error` — и
 * человек видел «restricted». Здесь фиксируем оба свойства ошибки: `message`
 * для показа, `code` для словарей на экранах.
 *
 * Запуск: npm run test -w web
 */
import { describe, expect, test, vi, afterEach } from 'vitest'
import { api, ApiError } from './api'

const answer = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => body,
  } as any)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ошибки ручек', () => {
  test('объяснение сервера побеждает машинный код', async () => {
    const explanation =
      'Сейчас вам недоступно: оценки и отзывы. Причина: спам. Ограничение действует до 20 августа 2026.'
    vi.stubGlobal('fetch', answer(403, { error: 'restricted', message: explanation }))

    await expect(api.clubs()).rejects.toThrow(explanation)
  })

  test('код остаётся доступен экранам со своими словарями', async () => {
    vi.stubGlobal('fetch', answer(403, { error: 'restricted', message: 'человеческий текст' }))

    const err = await api.clubs().catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('restricted')
    expect(err.status).toBe(403)
  })

  test('без объяснения сервера message остаётся кодом — старые словари работают', async () => {
    vi.stubGlobal('fetch', answer(404, { error: 'not_found' }))

    const err = await api.clubs().catch((e) => e)
    expect(err.message).toBe('not_found')
    expect(err.code).toBe('not_found')
  })
})
