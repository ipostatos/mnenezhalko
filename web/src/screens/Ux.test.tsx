/**
 * Правки интерфейса по аудиту 14.08.2026: то, что человек делает руками, и то,
 * что он при этом видит.
 *
 * Запуск: npm run test -w web
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AddBook } from './AddBook'
import { Cities } from './Cities'
import { MoodBoard } from './MoodBoard'
import { api } from '../api'

beforeEach(() => {
  vi.restoreAllMocks()
})

/* ── С23: двойной тап не заводит две книги ─────────────────── */

describe('сохранение книги', () => {
  test('второй тап по «Поставить на полку» не создаёт вторую книгу', async () => {
    // Проверка дублей уходит на сервер, и всё это время кнопка была живой.
    // Резолверы копим списком: каждый вызов создаёт СВОЙ промис, и разбудить
    // надо оба — иначе второй тап просто повиснет и тест ничего не проверит
    const release: ((v: any) => void)[] = []
    vi.spyOn(api, 'duplicates').mockImplementation(
      () => new Promise((res) => release.push(res)) as any,
    )
    const add = vi.spyOn(api, 'addBook').mockResolvedValue({
      book: { id: 'b1', title: 'Дюна' },
      moderation: { state: 'published', reason: 'moderation_off' },
      moderationNotice: null,
    } as any)
    vi.spyOn(api, 'facets').mockResolvedValue({ genres: [], languages: [], cities: [] } as any)

    render(<AddBook city="Warszawa" go={() => {}} isAdmin={false} />)
    fireEvent.change(screen.getByPlaceholderText('Название *'), { target: { value: 'Дюна' } })
    const save = screen.getByRole('button', { name: /Сохранить|Поставить на полку/i })

    fireEvent.click(save)
    fireEvent.click(save) // нетерпеливый второй тап, пока идёт проверка дублей
    release.forEach((r) => r({ own: null, others: null }))

    await waitFor(() => expect(add).toHaveBeenCalled())
    expect(add).toHaveBeenCalledTimes(1)
  })
})

/* ── С25: выбор города откатывается, если сервер отказал ───── */

describe('выбор города', () => {
  const cities = [{ city: 'Warszawa', books: 10, librarians: 2, groups: [] }] as any

  test('отказ сервера откатывает выбор, а не делает вид, что сохранилось', async () => {
    vi.spyOn(api, 'cities').mockResolvedValue(cities)
    vi.spyOn(api, 'setCity').mockRejectedValue(new Error('Не удалось сохранить'))
    const picked: (string | null)[] = []

    render(<Cities city={undefined} onPick={(v) => picked.push(v)} />)
    fireEvent.click(await screen.findByText('Warszawa'))
    fireEvent.click(await screen.findByRole('button', { name: /Это мой город/ }))

    await waitFor(() => expect(picked).toEqual(['Warszawa', null]))
  })

  test('успешный выбор ничего не откатывает', async () => {
    vi.spyOn(api, 'cities').mockResolvedValue(cities)
    vi.spyOn(api, 'setCity').mockResolvedValue({} as any)
    const picked: (string | null)[] = []

    render(<Cities city={undefined} onPick={(v) => picked.push(v)} />)
    fireEvent.click(await screen.findByText('Warszawa'))
    fireEvent.click(await screen.findByRole('button', { name: /Это мой город/ }))

    await waitFor(() => expect(api.setCity).toHaveBeenCalled())
    expect(picked).toEqual(['Warszawa'])
  })
})

/* ── Н28: кликается — значит кнопка ────────────────────────── */

describe('плашка выдач на главной', () => {
  const summary = {
    active: 2,
    overdue: 0,
    longestDays: 5,
    longestTitle: 'Дюна',
    mood: { level: 0, emoji: '🙂', label: 'всё хорошо' },
  } as any

  test('ведёт в «Выдачи» и доступна с клавиатуры', () => {
    const onOpen = vi.fn()
    render(<MoodBoard summary={summary} onOpen={onOpen} />)
    const el = screen.getByRole('button', { name: /Открыть выдачи/ })
    fireEvent.click(el)
    expect(onOpen).toHaveBeenCalled()
  })

  test('без обработчика остаётся обычной плашкой, а не кнопкой', () => {
    render(<MoodBoard summary={summary} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

/* ── С26: контраст белого на заливке ───────────────────────── */

/** Путь к таблице стилей — независимо от того, откуда запущен vitest. */
const CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css')

/** Относительная яркость по формуле WCAG. */
function luminance(hex: string): number {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lin = v.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

describe('читаемость подписей на заливке', () => {
  test('белый текст на сплошном акценте проходит норму AA', () => {
    const css = readFileSync(CSS_PATH, 'utf8')
    const solid = css.match(/--accent-solid:\s*(#[0-9a-f]{6})/i)?.[1]
    expect(solid, 'токен сплошной заливки должен существовать').toBeTruthy()

    const contrast = 1.05 / (luminance(solid!) + 0.05)
    expect(contrast).toBeGreaterThanOrEqual(4.5)
  })

  test('кнопки и активные чипы залиты именно им', () => {
    const css = readFileSync(CSS_PATH, 'utf8')
    const rules = ['.btn {', '.chip.active {', '.segmented button.active {']
    for (const rule of rules) {
      const body = css.slice(css.indexOf(rule), css.indexOf('}', css.indexOf(rule)))
      expect(body, `${rule} должен использовать --accent-solid под белым текстом`).toContain(
        'var(--accent-solid)',
      )
    }
  })
})
