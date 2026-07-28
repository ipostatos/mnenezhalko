import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { Route } from '../App'
import type { Book, Facets } from '../types'
import { useSeqGuard } from '../useSeqGuard'
import { openTg } from '../telegram'
import { MAIN_CHAT } from '../links'
import { BookRow } from './BookRow'
import { CoverCarousel, type CarouselBook } from './CoverCarousel'

/** Размер страницы каталога: дальше — «Показать ещё», а не потолок в 40 книг. */
const PAGE = 40

/**
 * Состояние экрана переживает переход library → книга → назад: без этого
 * основной сценарий (поиск в 3249 книгах) каждый раз сбрасывал запрос,
 * фильтры, набранные страницы и позицию скролла.
 */
type SavedState = {
  q: string
  genre?: string
  kind: string
  onlyMyCity: boolean
  items: Book[]
  total: number
  scrollY: number
}
let saved: SavedState | null = null

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
  // явные параметры из роутинга (плашка жанра на главной) важнее сохранённого
  const fresh = initialGenre !== undefined || initialKind !== undefined
  const restore = !fresh && saved ? saved : null

  const [q, setQ] = useState(restore?.q ?? '')
  const [genre, setGenre] = useState<string | undefined>(restore?.genre ?? initialGenre)
  const [kind, setKind] = useState<string>(restore?.kind ?? initialKind ?? 'book')
  const [onlyMyCity, setOnlyMyCity] = useState(restore?.onlyMyCity ?? Boolean(city))
  const [facets, setFacets] = useState<Facets | null>(null)
  const [items, setItems] = useState<Book[]>(restore?.items ?? [])
  const [total, setTotal] = useState(restore?.total ?? 0)
  const [loading, setLoading] = useState(!restore)
  const [loadingMore, setLoadingMore] = useState(false)
  /** сколько нашлось в других городах, когда «у себя» пусто (null — не считали) */
  const [elsewhere, setElsewhere] = useState<number | null>(null)
  const [showcase, setShowcase] = useState<CarouselBook[]>([])
  const [showcaseLoaded, setShowcaseLoaded] = useState(false)
  const seq = useRef(0)
  const skipFirstLoad = useRef(Boolean(restore))
  const facetsGuard = useSeqGuard()

  // refs, чтобы cleanup видел актуальные значения без пересоздания эффекта
  const qRef = useRef(q); qRef.current = q
  const genreRef = useRef(genre); genreRef.current = genre
  const kindRef = useRef(kind); kindRef.current = kind
  const onlyRef = useRef(onlyMyCity); onlyRef.current = onlyMyCity
  const itemsRef = useRef(items); itemsRef.current = items
  const totalRef = useRef(total); totalRef.current = total

  // уходим с экрана (открыли книгу) — запоминаем всё, включая скролл
  useEffect(() => {
    return () => {
      saved = {
        q: qRef.current,
        genre: genreRef.current,
        kind: kindRef.current,
        onlyMyCity: onlyRef.current,
        items: itemsRef.current,
        total: totalRef.current,
        scrollY: window.scrollY,
      }
    }
  }, [])

  // вернулись «назад» к сохранённому списку — восстанавливаем позицию скролла
  // (после scrollTo(0,0) в App, поэтому через таймер)
  useEffect(() => {
    if (!restore) return
    const y = restore.scrollY
    const t = setTimeout(() => window.scrollTo(0, y), 0)
    return () => clearTimeout(t)
  }, [])

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
      limit: PAGE,
    }),
    [q, genre, kind, onlyMyCity, city],
  )

  useEffect(() => {
    // сразу после восстановления состояния список уже на руках — не перезапрашиваем
    if (skipFirstLoad.current) {
      skipFirstLoad.current = false
      return
    }
    const id = ++seq.current
    setLoading(true)
    const timer = setTimeout(() => {
      api
        .books(params)
        .then((r) => {
          if (id !== seq.current) return
          // смена фильтра/запроса начинает пагинацию заново
          setItems(r.items)
          setTotal(r.total)
        })
        .catch(() => {})
        .finally(() => id === seq.current && setLoading(false))
    }, 250)
    return () => clearTimeout(timer)
  }, [params])

  // «в моём городе пусто» — подсказываем, есть ли книга в других городах
  useEffect(() => {
    setElsewhere(null)
    if (loading || total > 0 || !onlyMyCity || !city) return
    if (!q.trim() && !genre) return // без запроса счётчик «всей библиотеки» не подсказка
    const id = seq.current
    api
      .books({ ...params, city: undefined, limit: 1 })
      .then((r) => {
        if (id === seq.current) setElsewhere(r.total)
      })
      .catch(() => {})
  }, [loading, total, onlyMyCity, city, params])

  /** Следующая страница добавляется к текущей; её ошибка не трогает загруженное. */
  async function loadMore() {
    if (loadingMore || loading || items.length >= total) return
    const id = seq.current // страница валидна, пока не сменились фильтры
    setLoadingMore(true)
    try {
      const r = await api.books({ ...params, offset: items.length })
      if (id !== seq.current) return
      setItems((prev) => {
        const seen = new Set(prev.map((b) => b.id))
        return [...prev, ...r.items.filter((b) => !seen.has(b.id))]
      })
      setTotal(r.total)
    } catch {
      /* следующая страница не пришла — уже показанное не разрушаем */
    } finally {
      setLoadingMore(false)
    }
  }

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
          {onlyMyCity && city
            ? `В городе ${city} такого не нашлось.`
            : 'Ничего не нашлось. Попробуйте другое слово или снимите фильтры.'}
          {elsewhere !== null && elsewhere > 0 && (
            <>
              <div style={{ height: 'var(--sp-4)' }} />
              <button className="btn" onClick={() => setOnlyMyCity(false)}>
                Показать в других городах ({elsewhere})
              </button>
            </>
          )}
          <div style={{ height: 'var(--sp-4)' }} />
          <button className="btn ghost" onClick={() => openTg(MAIN_CHAT)}>
            💬 Спросить в чате проекта
          </button>
        </div>
      )}

      {items.map((b) => (
        <BookRow key={b.id} book={b} onOpen={() => go({ name: 'book', id: b.id })} />
      ))}

      {items.length > 0 && total > items.length && (
        <button className="btn ghost" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Загружаю…' : `Показать ещё (осталось ${total - items.length})`}
        </button>
      )}
    </>
  )
}
