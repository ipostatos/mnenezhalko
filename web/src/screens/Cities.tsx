import { useEffect, useState } from 'react'
import { api } from '../api'
import type { CityInfo } from '../types'
import { haptic, openTg } from '../telegram'

export function Cities({
  city,
  onPick,
}: {
  city?: string
  onPick: (value: string | null) => void
}) {
  const [cities, setCities] = useState<CityInfo[]>([])
  const [open, setOpen] = useState<string | null>(city ?? null)

  useEffect(() => {
    api.cities().then(setCities).catch(() => {})
  }, [])

  return (
    <>
      <h1>Города</h1>
      <div className="sub">
        Выберите свой — библиотека, встречи и барахолка станут «рядом с вами».
      </div>

      {cities.map((c) => (
        <div key={c.city}>
          <button
            className="row-card"
            onClick={() => {
              haptic()
              setOpen((v) => (v === c.city ? null : c.city))
            }}
          >
            <div className="ic-tile" style={{ ['--tone' as any]: c.city === city ? '#4caf72' : undefined }}>
              {c.city === city ? '📍' : '🏙'}
            </div>
            <div className="grow">
              <div className="t">{c.city}</div>
              <div className="d">
                {c.books} книг{c.groups.length ? ` · ${c.groups.length} чат(а)` : ''}
              </div>
            </div>
            <div className="chev">{open === c.city ? '⌄' : '›'}</div>
          </button>

          {open === c.city && (
            <div style={{ padding: '0 0 var(--sp-3)' }}>
              {c.groups.map((g) => (
                <button key={g.id} className="row-card" onClick={() => openTg(g.url)}>
                  <div className="ic-tile sm">💬</div>
                  <div className="grow">
                    <div className="t-sm">{g.title}</div>
                    <div className="d">Открыть чат</div>
                  </div>
                  <div className="chev">›</div>
                </button>
              ))}
              {c.groups.length === 0 && (
                <div className="warn-banner">
                  Ссылка на чат этого города ещё не добавлена — напишите админам в общий чат.
                </div>
              )}
              <button
                className={`btn ${c.city === city ? 'ghost' : ''}`}
                onClick={() => {
                  haptic('success')
                  const next = c.city === city ? null : c.city
                  onPick(next)
                  api.setCity(next).catch(() => {})
                }}
              >
                {c.city === city ? 'Убрать мой город' : `Это мой город`}
              </button>
            </div>
          )}
        </div>
      ))}

      <div className="foot">
        Город сохраняется только для показа — в базе он берётся из карточки библиотекаря.
      </div>
    </>
  )
}
