import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Route } from '../App'
import type { Book, Owner } from '../types'
import { haptic, openTg } from '../telegram'
import { BookRow } from './BookRow'

export function Shelf({ id, go }: { id: string; go: (r: Route) => void }) {
  const [data, setData] = useState<{ owner: Owner; books: Book[] } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.librarian(id).then(setData).catch((e) => setError(e.message))
  }, [id])

  if (error) return <div className="error-banner">{error}</div>
  if (!data) return <div className="spinner">Загружаю полку…</div>

  const { owner, books } = data
  return (
    <>
      <h1>{owner.name}</h1>
      <div className="sub">
        {owner.city ? (owner.district ? `${owner.city} / ${owner.district}` : owner.city) : 'Библиотекарь проекта'}
        {' · '}
        {books.length} книг
      </div>

      {owner.telegram && (
        <>
          <button
            className="btn"
            onClick={() => {
              haptic('medium')
              openTg(`https://t.me/${owner.telegram}`)
            }}
          >
            💬 Написать @{owner.telegram}
          </button>
          <div style={{ height: 'var(--sp-4)' }} />
        </>
      )}

      <div className="section-title">На полке</div>
      {books.map((b) => (
        <BookRow key={b.id} book={b} onOpen={() => go({ name: 'book', id: b.id })} />
      ))}
    </>
  )
}
