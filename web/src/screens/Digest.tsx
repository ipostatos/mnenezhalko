import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Route } from '../App'
import type { DigestResult } from '../types'
import { BookRow } from './BookRow'

const LABEL: Record<'day' | 'month', string> = { day: 'за сутки', month: 'за месяц' }

/** Что нового появилось на полках — за сутки и за месяц. */
export function Digest({ city, go }: { city?: string; go: (r: Route) => void }) {
  const [period, setPeriod] = useState<'day' | 'month'>('day')
  const [data, setData] = useState<DigestResult | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api
      .digest(period, city)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [period, city])

  return (
    <>
      <h1>Новинки</h1>
      <div className="sub">
        {city ? `Что появилось в городе ${city}` : 'Что появилось на полках проекта'}
      </div>

      <div className="segmented">
        <button className={period === 'day' ? 'active' : ''} onClick={() => setPeriod('day')}>
          24 часа
        </button>
        <button className={period === 'month' ? 'active' : ''} onClick={() => setPeriod('month')}>
          Месяц
        </button>
      </div>

      {loading && <div className="muted">Загружаю…</div>}

      {!loading && data && data.total === 0 && (
        <div className="empty">
          <div className="big">🌱</div>
          Новинок {LABEL[period]} пока нет.
          <div style={{ height: 'var(--sp-4)' }} />
          <button className="btn" onClick={() => go({ name: 'add' })}>
            Добавить свою книгу
          </button>
        </div>
      )}

      {!loading && data && data.total > 0 && (
        <>
          <div className="section-title">
            {data.total} {LABEL[period]}
          </div>
          {!city && data.byCity.length > 1 && (
            <div className="chips" style={{ marginBottom: 'var(--sp-3)' }}>
              {data.byCity.slice(0, 6).map((c) => (
                <span key={c.city} className="chip sm static">
                  {c.city} · {c.count}
                </span>
              ))}
            </div>
          )}
          {data.items.map((b) => (
            <BookRow key={b.id} book={b} onOpen={() => go({ name: 'book', id: b.id })} />
          ))}
          {data.total > data.items.length && (
            <div className="foot">…и ещё {data.total - data.items.length} в библиотеке</div>
          )}
        </>
      )}
    </>
  )
}
