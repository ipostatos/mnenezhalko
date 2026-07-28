import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { Route } from '../App'
import type { Book, Facets } from '../types'
import { useSeqGuard } from '../useSeqGuard'
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
  const [showcaseLoaded, setShowcaseLoaded] = useState(false)
  const seq = useRef(0)
  const facetsGuard = useSeqGuard()

  useEffect(() => {
    // тумблер города: медленные фасеты старого фильтра не перетирают новые
    const id = facetsGuard.next()
    api
      .facets(onlyMyCity ? city : undefined)
      .then((f) => facetsGuard.isCurrent(id) && setFacets(f))
      .catch(() => {})
  }, [city, onlyMyCity])

  useEffect(() => {
    api
      .showcase()
      .then(setShowcase)
      .catch(() => {})
      .finally(() => setShowcaseLoaded(true))
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
  // если её нет в витрине — вставляем в СЕРЕДИНУ (там же старт), чтобы карусель
  // не прокручивалась через всю ленту к началу
  const firstMatch = q.trim().length >= 2 ? items.find((b) => b.coverUrl) : undefined
  const carouselBooks: CarouselBook[] = useMemo(() => {
    if (firstMatch && !showcase.some((b) => b.id === firstMatch.id)) {
      const arr = showcase.slice()
      arr.splice(Math.floor(arr.length / 2), 0, {
        id: firstMatch.id,
        title: firstMatch.title,
        // центр карусели рисуется 156 CSS px (312 физических) — превью списка
        // (96px) здесь превращалось в мыло на самом крупном элементе экрана
        coverUrl: firstMatch.coverUrl320 ?? firstMatch.coverUrl!,
      })
      return arr
    }
    return showcase
  }, [showcase, firstMatch])

  return (
    <>
      <h1>Библиотека</h1>
      <div className="sub">
        {loading ? 'Ищу…' : `${total} ${kind === 'game' ? 'игр' : 'книг'} на полках библиотекарей`}
      </div>

      {carouselBooks.length > 0 ? (
        <CoverCarousel
          books={carouselBooks}
          centerId={firstMatch?.id}
          onOpen={(id) => go({ name: 'book', id })}
        />
      ) : (
        !showcaseLoaded && (
          <div className="cc-skel" aria-hidden>
            <span />
            <span />
            <span />
          </div>
        )
      )}

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
