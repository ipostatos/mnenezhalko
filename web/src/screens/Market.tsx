import { useEffect, useState } from 'react'
import { api } from '../api'
import type { MarketItem } from '../types'
import { openTg } from '../telegram'

const LABEL: Record<string, string> = {
  give: '🎁 Отдам',
  sell: '💰 Продам',
  search: '🔎 Ищу',
}

const BOT = 'https://t.me/mnenezhalkobot?start=baraholka'

export function Market({ city }: { city?: string }) {
  const [items, setItems] = useState<MarketItem[] | null>(null)
  const [onlyMyCity, setOnlyMyCity] = useState(Boolean(city))

  useEffect(() => {
    api
      .market(onlyMyCity ? city : undefined)
      .then(setItems)
      .catch(() => setItems([]))
  }, [city, onlyMyCity])

  return (
    <>
      <h1>Барахолка</h1>
      <div className="sub">Книги, полки, коробки — отдам, продам, ищу</div>

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

      {items === null && <div className="spinner">Загружаю…</div>}

      {items?.length === 0 && (
        <div className="empty">
          <div className="big">🛍</div>
          Пока пусто — будьте первым.
        </div>
      )}

      {items?.map((i) => (
        <div key={i.id} className="row-card static">
          <div className="cover">
            {i.photo ? (
              <img src={`/api/photo/${i.photo}`} alt="" loading="lazy" />
            ) : (
              <span>{LABEL[i.kind]?.slice(0, 2) ?? '🛍'}</span>
            )}
          </div>
          <div className="grow">
            <div className="t-sm">
              {LABEL[i.kind] ?? ''} {i.title}
            </div>
            <div className="d">
              {i.city}
              {i.price ? ` · ${i.price}` : ''}
            </div>
            {i.description && <div className="d" style={{ marginTop: 4 }}>{i.description}</div>}
          </div>
          {i.authorUsername && (
            <button
              className="btn ghost sm"
              onClick={() => openTg(`https://t.me/${i.authorUsername}`)}
            >
              💬
            </button>
          )}
        </div>
      ))}

      <div className="fab-bar">
        <button className="btn" onClick={() => openTg(BOT)}>
          ➕ Разместить объявление
        </button>
      </div>
    </>
  )
}
