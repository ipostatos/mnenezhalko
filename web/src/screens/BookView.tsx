import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Route } from '../App'
import type { Book } from '../types'
import { haptic, openTg } from '../telegram'

export function BookView({ id, go }: { id: string; go: (r: Route) => void }) {
  const [book, setBook] = useState<Book | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.book(id).then(setBook).catch((e) => setError(e.message))
  }, [id])

  if (error) return <div className="error-banner">Не получилось открыть карточку: {error}</div>
  if (!book) return <div className="spinner">Загружаю…</div>

  const owner = book.owner
  const contactUrl = owner?.telegram ? `https://t.me/${owner.telegram}` : null

  return (
    <>
      <div className="book-hero">
        <div className="cover lg">
          {book.coverUrl ? (
            <img
              src={book.coverUrl}
              alt=""
              onError={(e) => (e.currentTarget.style.display = 'none')}
            />
          ) : (
            <span>{book.title.slice(0, 1).toUpperCase()}</span>
          )}
        </div>
        <div className="grow">
          <h1>{book.title}</h1>
          {book.author && <div className="sub" style={{ marginBottom: 8 }}>{book.author}</div>}
          <div className="chips">
            {book.genres.slice(0, 4).map((g) => (
              <span key={g} className="chip sm" style={{ cursor: 'default' }}>
                {g}
              </span>
            ))}
            {book.languages.map((l) => (
              <span key={l} className="chip sm" style={{ cursor: 'default' }}>
                {l}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="section-title">У кого взять</div>
      {owner ? (
        <>
          <div className="card" style={{ marginBottom: 'var(--sp-3)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
              <div className="avatar">{owner.name.slice(0, 1).toUpperCase()}</div>
              <div className="grow">
                <div className="t-sm" style={{ fontWeight: 700 }}>{owner.name}</div>
                <div className="d muted">
                  {owner.city
                    ? owner.district
                      ? `${owner.city} / ${owner.district}`
                      : owner.city
                    : 'город не указан'}
                </div>
              </div>
            </div>
          </div>

          {contactUrl ? (
            <button
              className="btn"
              onClick={() => {
                haptic('medium')
                openTg(contactUrl)
              }}
            >
              💬 Написать @{owner.telegram}
            </button>
          ) : (
            <div className="warn-banner">
              У библиотекаря не указан Telegram — спросите в чате проекта.
            </div>
          )}

          <div style={{ height: 'var(--sp-2)' }} />
          <button className="btn ghost" onClick={() => go({ name: 'shelf', id: owner.id })}>
            📚 Вся полка этого библиотекаря
          </button>
        </>
      ) : (
        <div className="warn-banner">Владелец не указан — уточните в чате проекта.</div>
      )}

      <div className="foot">
        Договоритесь напрямую: когда и где встретиться, на какой срок берёте книгу.
      </div>
    </>
  )
}
