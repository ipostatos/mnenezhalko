import { useEffect, useState } from 'react'
import { api } from '../api'
import type { BookClub } from '../types'
import { openTg, haptic } from '../telegram'
import { Icon } from './Icon'

/**
 * Книжные клубы проекта (B7, ТЗ 5.08.2026).
 *
 * Раньше клуб был один и открывался прямо с главной ссылкой в чат. Но городов
 * девять, а в одном городе клубов может быть несколько — поэтому здесь список,
 * сгруппированный по городам, где у каждого клуба своя карточка и своя ссылка.
 * Группировка — только показ: клуб выбирает человек, а не город за него.
 */
export function Clubs() {
  const [clubs, setClubs] = useState<BookClub[] | null>(null)

  useEffect(() => {
    api
      .clubs()
      .then(setClubs)
      .catch(() => setClubs([]))
  }, [])

  if (!clubs) return <div className="muted">Загружаю…</div>

  // клубы без города (общие для проекта) идут первыми — это «клуб проекта»,
  // а не забытое поле
  const cities = [...new Set(clubs.map((c) => c.city))].sort((a, b) =>
    a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'ru'),
  )

  return (
    <>
      <h1>Книжные клубы</h1>
      <div className="sub">Читаем вместе и встречаемся — выберите свой</div>

      {!clubs.length && (
        <div className="muted" style={{ marginTop: 'var(--sp-5)' }}>
          Клубы пока не заведены. Спросите в общем чате проекта — подскажем, что рядом.
        </div>
      )}

      {cities.map((city) => (
        <div key={city || 'all'}>
          <div className="section-title">{city || 'Для всего проекта'}</div>
          {clubs
            .filter((c) => c.city === city)
            .map((c) => (
              <button
                key={c.id}
                className="row-card"
                style={{ ['--tone' as any]: '#DD93C2' }}
                onClick={() => {
                  haptic()
                  openTg(c.url)
                }}
              >
                <div className="ic-tile">
                  <Icon name="flower" />
                </div>
                <div className="grow">
                  <div className="t-sm">{c.name}</div>
                  {c.description && <div className="d">{c.description}</div>}
                  <div className="d">Открыть чат</div>
                </div>
                <div className="chev">›</div>
              </button>
            ))}
        </div>
      ))}
    </>
  )
}
