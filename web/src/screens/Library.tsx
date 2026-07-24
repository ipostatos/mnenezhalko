import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { Route } from '../App'
import type { Book, Facets } from '../types'
import { BookRow } from './BookRow'
import { CoverCarousel, type CarouselBook } from './CoverCarousel'

export function Library({
  go,
  city,
  genre: initialGenre,
  kind: initialKind,
}: {
  go: (r: Route) => void
  city?: string
  genre?: string
  kind?: string
}) {
  const [q, setQ] = useState('')
  const [genre, setGenre] = useState<string | undefined>(initialGenre)
  const [kind, setKind] = useState<string>(initialKind ?? 'book')
  const [onlyMyCity, setOnlyMyCity] = useState(Boolean(city))
  const [facets, setFacets] = useState<Facets | null>(null)
  const [items, setItems] = useState<Book[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [showcase, setShowcase] = useState<CarouselBook[]>([])
  const seq = useRef(0)

  useEffect(() => {
    api.facets(onlyMyCity ? city : undefined).then(setFacets).catch(() => {})
  }, [city, onlyMyCity])

  useEffect(() => {
    api.showcase().then(setShowcase).catch(() => {})
  }, [])

  const params = useMemo(
    () => ({
      q: q.trim() || undefined,
      genre,
      kind,
      city: onlyMyCity ? city : undefined,
      limit: 40,
    }),
    [q, genre, kind, onlyMyCity, city],
  )

  useEffect(() => {
    const id = ++seq.current
    setLoading(true)
    const timer = setTimeout(() => {
      api
        .books(params)
        .then((r) => {
          if (id !== seq.current) return
          setItems(r.items)
          setTotal(r.total)
        })
        .catch(() => {})
        .finally(() => id === seq.current && setLoading(false))
    }, 250)
    return () => clearTimeout(timer)
  }, [params])

  // при поиске подводим найденную книгу (с обложкой) в центр карусели;
  // если её нет в витрине — добавляем в начало
  const firstMatch = q.trim().length >= 2 ? items.find((b) => b.coverUrl) : undefined
  const carouselBooks: CarouselBook[] =
    firstMatch && !showcase.some((b) => b.id === firstMatch.id)
      ? [{ id: firstMatch.id, title: firstMatch.title, coverUrl: firstMatch.coverUrl! }, ...showcase]
      : showcase

  return (
    <>
      <h1>Библиотека</h1>
      <div className="sub">
        {loading ? 'Ищу…' : `${total} ${kind === 'game' ? 'игр' : 'книг'} на полках библиотекарей`}
      </div>

      <CoverCarousel
        books={carouselBooks}
        centerId={firstMatch?.id}
        onOpen={(id) => go({ name: 'book', id })}
      />

      <input
        className="input"
        placeholder="Название или автор…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      <div style={{ height: 'var(--sp-3)' }} />

      <div className="segmented">
        <button className={kind === 'book' ? 'active' : ''} onClick={() => setKind('book')}>
          Книги
        </button>
        <button className={kind === 'game' ? 'active' : ''} onClick={() => setKind('game')}>
          Настолки
        </button>
      </div>

      {city && (
        <div className="chips" style={{ marginBottom: 'var(--sp-3)' }}>
          <button
            className={`chip sm ${onlyMyCity ? 'active' : ''}`}
            onClick={() => setOnlyMyCity((v) => !v)}
          >
            📍 {city}
          </button>
        </div>
      )}

      {kind === 'book' && facets && facets.genres.length > 0 && (
        <>
          <div className="section-title">Жанры</div>
          <div className="chips" style={{ marginBottom: 'var(--sp-4)' }}>
            {genre && (
              <button className="chip sm active" onClick={() => setGenre(undefined)}>
                {genre} ✕
              </button>
            )}
            {!genre &&
              facets.genres.slice(0, 14).map((g) => (
                <button key={g.value} className="chip sm" onClick={() => setGenre(g.value)}>
                  {g.value} <span className="muted">{g.count}</span>
                </button>
              ))}
          </div>
        </>
      )}

      {!loading && items.length === 0 && (
        <div className="empty">
          <img className="illus sm" src="/il/stack.jpg" alt="" loading="lazy" />
          Ничего не нашлось. Попробуйте другое слово или снимите фильтры.
        </div>
      )}

      {items.map((b) => (
        <BookRow key={b.id} book={b} onOpen={() => go({ name: 'book', id: b.id })} />
      ))}

      {items.length > 0 && total > items.length && (
        <div className="foot">Показаны первые {items.length} из {total} — уточните запрос</div>
      )}
    </>
  )
}
