/**
 * Экран «Ваши данные».
 *
 * Проверяем то, на что жаловался user 4.08.2026 и что легко вернуть назад
 * незаметно: выгрузка идёт файлом в чат с ботом (а не blob-ссылкой, которая
 * подвешивала вебвью Telegram), реквизиты контролёра видны, а незаполненные
 * поля не рисуются пустыми строками.
 *
 * Запуск: npm run test -w web
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MyData } from './MyData'
import { api } from '../api'
import { CONTROLLER, isPlaceholder } from '../privacy-text'

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('выгрузка своих данных', () => {
  test('файл просит бот прислать в чат, а не скачивает blob-ссылкой', async () => {
    const send = vi.spyOn(api, 'sendMyData').mockResolvedValue({ ok: true })
    const download = vi.spyOn(api, 'exportMyData')
    // если кто-то вернёт скачивание файлом из вебвью — тест это покажет
    const objectUrl = vi.fn(() => 'blob:x')
    vi.stubGlobal('URL', { ...URL, createObjectURL: objectUrl })

    render(<MyData go={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Прислать мои данные файлом/ }))

    await waitFor(() => expect(send).toHaveBeenCalled())
    expect(objectUrl).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  test('если бот не смог прислать — данные всё равно отдаём, через буфер обмена', async () => {
    vi.spyOn(api, 'sendMyData').mockRejectedValue(new Error('send_failed'))
    const dump = vi.spyOn(api, 'exportMyData').mockResolvedValue({ profile: {} })
    const write = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } })

    render(<MyData go={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Прислать мои данные файлом/ }))

    await waitFor(() => expect(write).toHaveBeenCalled())
    expect(dump).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('кто отвечает за данные', () => {
  test('заполненные реквизиты показаны, незаполненные не рисуются', () => {
    render(<MyData go={() => {}} />)

    expect(screen.getByText(CONTROLLER.name)).toBeTruthy()
    expect(screen.getByText(CONTROLLER.email)).toBeTruthy()
    // адрес не заполнен — ни строки-заглушки, ни пустого поля быть не должно
    expect(isPlaceholder(CONTROLLER.address)).toBe(true)
    expect(screen.queryByText('Адрес')).toBeNull()
    expect(screen.queryByText(/Реквизиты ещё не заполнены/)).toBeNull()
  })
})

describe('сколько храним', () => {
  test('у каждой строки есть и «что», и срок — ни одна не осталась половинкой', () => {
    const { container } = render(<MyData go={() => {}} />)
    const rows = [...container.querySelectorAll('.retention-row')]
    expect(rows.length).toBeGreaterThan(10)
    for (const row of rows) {
      expect(row.querySelector('.w')?.textContent?.trim()).toBeTruthy()
      expect(row.querySelector('.h')?.textContent?.trim()).toBeTruthy()
    }
  })
})
