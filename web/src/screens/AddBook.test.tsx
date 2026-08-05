/**
 * Экран «Добавить книгу»: что человек читает после сохранения (A2, ТЗ 5.08.2026).
 *
 * Повод: админ сохраняет книгу и она сразу в каталоге — со стороны неотличимо
 * от «модерация не работает». Правило не меняли (публиковать свои книги — право
 * модератора), но исход теперь называет сервер, а приложение только показывает
 * его текст. Тест сторожит обе стороны договорённости: текст ВИДЕН и текст НЕ
 * СВОЙ (иначе формулировки в боте и в приложении разъедутся).
 *
 * Запуск: npm run test -w web
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AddBook } from './AddBook'
import { api } from '../api'
import type { ShelfResult } from '../types'

const book = (over: Record<string, unknown> = {}) =>
  ({
    id: 'b1',
    title: 'Дюна',
    kind: 'book',
    author: null,
    genres: [],
    languages: [],
    city: 'Warszawa',
    district: null,
    coverUrl: null,
    status: 'free',
    source: 'bot',
    owner: null,
    ...over,
  }) as ShelfResult['book']

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(api, 'facets').mockResolvedValue({
    cities: [],
    genres: [],
    languages: [],
    genreOptions: [],
    languageOptions: [],
  } as any)
  // own=null — «своего дубля нет»: иначе сохранение спросит подтверждение
  vi.spyOn(api, 'duplicates').mockResolvedValue({ own: null, others: null } as any)
})

async function fillAndSave() {
  render(<AddBook go={() => {}} city="Warszawa" />)
  fireEvent.change(screen.getByPlaceholderText('Название *'), { target: { value: 'Дюна' } })
  fireEvent.click(screen.getByRole('button', { name: /Сохранить|Поставить на полку/i }))
}

describe('исход модерации после сохранения', () => {
  test('админу объясняем, почему книга появилась в каталоге сразу', async () => {
    vi.spyOn(api, 'addBook').mockResolvedValue({
      book: book({ reviewStatus: 'approved' }),
      notionStatus: 'synced',
      notionError: null,
      moderation: { state: 'published', reason: 'admin' },
      moderationNotice: 'Книга опубликована сразу, потому что вы администратор.',
    } as ShelfResult)

    await fillAndSave()
    await screen.findByText(/потому что вы администратор/i)
  })

  test('обычному участнику показываем текст сервера, а не свою копию', async () => {
    vi.spyOn(api, 'addBook').mockResolvedValue({
      book: book({ reviewStatus: 'pending' }),
      notionStatus: 'pending',
      notionError: null,
      moderation: { state: 'pending' },
      moderationNotice: 'ТЕКСТ-С-СЕРВЕРА про проверку',
    } as ShelfResult)

    await fillAndSave()
    // ровно серверная фраза: если экран снова начнёт печатать свою, тест упадёт
    await screen.findByText('ТЕКСТ-С-СЕРВЕРА про проверку')
    expect(screen.queryByText(/отправлена на проверку модератору/i)).toBeNull()
  })

  test('когда объяснять нечего (модерация выключена) — лишней строки нет', async () => {
    vi.spyOn(api, 'addBook').mockResolvedValue({
      book: book({ reviewStatus: 'approved' }),
      notionStatus: 'synced',
      notionError: null,
      moderation: { state: 'published', reason: 'moderation_off' },
      moderationNotice: null,
    } as ShelfResult)

    await fillAndSave()
    await screen.findByText(/Книга на полке/i)
    await waitFor(() => expect(screen.queryByText(/администратор/i)).toBeNull())
  })
})
