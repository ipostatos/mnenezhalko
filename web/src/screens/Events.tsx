import { useEffect, useState } from 'react'
import { api } from '../api'
import type { EventItem } from '../types'
import { openTg } from '../telegram'
import { useSeqGuard } from '../useSeqGuard'

const fmt = new Intl.DateTimeFormat('ru-RU', {
  weekday: 'short',
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Warsaw',
})

export function Events({ city }: { city?: string }) {
  const [events, setEvents] = useState<EventItem[] | null>(null)
  const [onlyMyCity, setOnlyMyCity] = useState(Boolean(city))
  const guard = useSeqGuard()

  useEffect(() => {
    // тумблер города: старый медленный ответ не перетирает новый фильтр
    const id = guard.next()
    api
      .events(onlyMyCity ? city : undefined)
      .then((r) => guard.isCurrent(id) && setEvents(r))
      .catch(() => guard.isCurrent(id) && setEvents([]))
  }, [city, onlyMyCity])

  return (
    <>
      <h1>Встречи</h1>
      <div className="sub">Ближайшие события проекта по городам</div>

      {city && (
        <div className="chips" style={{ marginBottom: 'var(--sp-4)' }}>
          <button
            className={`chip sm ${onlyMyCity ? 'active' : ''}`}
            onClick={() => setOnlyMyCity((v) => !v)}
          >
            📍 только {city}
          </button>
        </div>
      )}

      {events === null && <div className="spinner">Загружаю…</div>}

      {events?.length === 0 && (
        <div className="empty">
          <div className="big">📅</div>
          Ближайших встреч пока нет.
          <br />
          Анонсы появляются в чате проекта.
        </div>
      )}

      {events?.map((e) => (
        <div key={e.id} className="row-card static">
          <div className="ic-tile" style={{ ['--tone' as any]: '#e0a13a' }}>
            📅
          </div>
          <div className="grow">
            <div className="t-sm">{e.title}</div>
            <div className="d">{fmt.format(new Date(e.startsAt))}</div>
            <div className="d">
              {e.city}
              {e.place ? `, ${e.place}` : ''}
            </div>
            {e.description && <div className="d" style={{ marginTop: 4 }}>{e.description}</div>}
          </div>
          {e.url && (
            <button className="btn ghost sm" onClick={() => openTg(e.url!)}>
              →
            </button>
          )}
        </div>
      ))}
    </>
  )
}
