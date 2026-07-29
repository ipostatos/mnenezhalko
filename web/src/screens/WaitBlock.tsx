import { useState } from 'react'
import { api } from '../api'
import type { Book, Waitlist } from '../types'
import { haptic } from '../telegram'

/**
 * Очередь на занятую книгу в карточке (issue #10).
 *
 * Блок показывается, только когда книга на руках: у свободной книги ждать
 * нечего, надо просто написать владельцу. Соседей по очереди человек не видит
 * никогда — сервер отдаёт лишь число ждущих и своё место (см. waitlist.ts).
 */
export function WaitBlock({ book }: { book: Book }) {
  const [waiting, setWaiting] = useState<Waitlist | null>(book.waiting ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const onShelf = book.status !== 'busy'
  const mine = waiting?.mine ?? null
  // у свободной книги блок не нужен; исключение — если человек всё ещё числится
  // в очереди: тогда честнее показать это и дать выйти
  if (onShelf && !mine) return null

  async function join() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const r = await api.wait(book.id)
      setWaiting(r.waiting)
      haptic('success')
    } catch (e: any) {
      setError(errorText(e?.message))
    } finally {
      setBusy(false)
    }
  }

  async function leave() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const r = await api.unwait(book.id)
      setWaiting(r.waiting)
      haptic('light')
    } catch (e: any) {
      setError(errorText(e?.message))
    } finally {
      setBusy(false)
    }
  }

  const count = waiting?.count ?? 0
  const ready = mine?.status === 'ready'

  return (
    <div className="wait-block card">
      <div className="wait-head">
        <span className="wait-dot" aria-hidden="true" />
        <div className="grow">
          <div className="t-sm" style={{ fontWeight: 700 }}>
            {ready ? 'Книга освободилась' : onShelf ? 'Книга снова на полке' : 'Сейчас на руках'}
          </div>
          <div className="d muted">
            {ready
              ? 'Напишите владельцу, пока её не взяли'
              : mine
                ? `Вы ${mine.position}-й в очереди${count > 1 ? ` из ${count}` : ''}`
                : count > 0
                  ? `Уже ждут: ${count}`
                  : 'Сообщим, как только вернётся владельцу'}
          </div>
        </div>
      </div>

      {mine ? (
        <button className="btn ghost sm" onClick={leave} disabled={busy}>
          🔕 Не ждать
        </button>
      ) : (
        <button className="btn" onClick={join} disabled={busy}>
          🔔 Сообщить, когда освободится
        </button>
      )}

      {error && <div className="warn-banner sm">{error}</div>}
    </div>
  )
}

/** Коды сервера человеческим языком: человек не должен читать own_book. */
export function errorText(code?: string): string {
  switch (code) {
    case 'own_book':
      return 'Это ваша книга — вы и так узнаете, когда её вернут.'
    case 'not_busy':
      return 'Книга уже свободна: напишите владельцу напрямую.'
    case 'book_unavailable':
      return 'Книги больше нет в библиотеке.'
    case 'too_many':
      return 'Слишком много книг в ожидании. Выйдите из какой-нибудь очереди и попробуйте снова.'
    case 'unauthorized':
      return 'Откройте приложение из бота, чтобы встать в очередь.'
    case 'too_many_requests':
    case 'HTTP 429':
      return 'Слишком часто. Попробуйте через минуту.'
    default:
      return 'Не получилось. Попробуйте ещё раз.'
  }
}
