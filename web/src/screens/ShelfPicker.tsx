import { useEffect, useState } from 'react'
import type { Book } from '../types'
import { haptic } from '../telegram'
import { plural } from '../plural'
import { norm, bookMatches } from './Loans'

/**
 * Выбор книги из ВСЕЙ своей полки — для формы выдачи.
 *
 * Подсказка под полем показывает только пять первых совпадений, и, если книгу
 * помнишь смутно, приходилось вспоминать точное название (жалоба user
 * 29.07.2026). Здесь список целиком: с обложками, с поиском и с честной
 * пометкой у тех книг, что уже на руках, — выдать их нельзя, но и молча
 * прятать нельзя, иначе выглядит как потеря книги.
 */
export function ShelfPicker({
  books,
  onPick,
  onClose,
}: {
  books: Book[]
  onPick: (b: Book) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')

  // «назад» на телефоне должен закрывать список, а не уводить с экрана выдач
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const needle = norm(q)
  const matched = needle ? books.filter((b) => bookMatches(b, needle)) : books
  const free = matched.filter((b) => b.status !== 'busy')
  const busy = matched.filter((b) => b.status === 'busy')

  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Выбор книги с полки" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="t">Ваша полка</div>
          <button className="sheet-close" aria-label="Закрыть" onClick={onClose}>
            ✕
          </button>
        </div>

        <input
          className="input"
          placeholder="Поиск: название или автор…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />

        <div className="sheet-body">
          {!matched.length && (
            <div className="muted" style={{ padding: 'var(--sp-4) 0' }}>
              {books.length
                ? 'На полке такого нет. Попробуйте другое слово.'
                : 'На вашей полке пока нет книг.'}
            </div>
          )}

          {free.map((b) => (
            <button
              key={b.id}
              className="pick-row"
              onClick={() => {
                haptic('light')
                onPick(b)
              }}
            >
              <div className="cover">
                {b.coverUrl ? (
                  <img src={b.coverUrl} alt="" loading="lazy" />
                ) : (
                  <span>{b.title.slice(0, 1).toUpperCase()}</span>
                )}
              </div>
              <div className="grow">
                <div className="t-sm">{b.title}</div>
                {b.author && <div className="d">{b.author}</div>}
              </div>
            </button>
          ))}

          {busy.length > 0 && (
            <>
              <div className="section-title">Уже на руках · {busy.length}</div>
              {busy.map((b) => (
                <div key={b.id} className="pick-row disabled">
                  <div className="cover">
                    {b.coverUrl ? (
                      <img src={b.coverUrl} alt="" loading="lazy" />
                    ) : (
                      <span>{b.title.slice(0, 1).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="grow">
                    <div className="t-sm">{b.title}</div>
                    <div className="d">сначала отметьте возврат</div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="sheet-foot muted">
          {books.length} {plural(books.length, ['книга', 'книги', 'книг'])} на полке
        </div>
      </div>
    </div>
  )
}
