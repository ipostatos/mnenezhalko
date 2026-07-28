import { useEffect, useState } from 'react'
import { api } from '../api'
import type { MarketItem } from '../types'
import { openTg } from '../telegram'
import { useSeqGuard } from '../useSeqGuard'

const LABEL: Record<string, string> = {
  give: '🎁 Отдам',
  sell: '💰 Продам',
  search: '🔎 Ищу',
}

/** Барахолка — витрина темы чата: размещают объявления там. */
const MARKET_TOPIC = 'https://t.me/c/1856176764/4547'

export function Market({ city }: { city?: string }) {
  const [items, setItems] = useState<MarketItem[] | null>(null)
  const [onlyMyCity, setOnlyMyCity] = useState(Boolean(city))
  const guard = useSeqGuard()

  useEffect(() => {
    // тумблер города: старый медленный ответ не перетирает новый фильтр
    const id = guard.next()
    api
      .market(onlyMyCity ? city : undefined)
      .then((r) => guard.isCurrent(id) && setItems(r))
      .catch(() => guard.isCurrent(id) && setItems([]))
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
        <div key={i.id} className="row-card static market-card">
          <div className="cover">
            {i.photo ? (
              // из бота приходит telegram file_id, из импорта — готовая ссылка
              <img
                src={i.photo.startsWith('http') || i.photo.startsWith('/') ? i.photo : `/api/photo/${i.photo}`}
                alt=""
                loading="lazy"
              />
            ) : (
              <span>{LABEL[i.kind]?.slice(0, 2) ?? '🛍'}</span>
            )}
          </div>
          <div className="grow">
            <div className="t-sm">{i.title}</div>
            <div className="market-meta">
              <span className={`tag ${i.kind}`}>{LABEL[i.kind] ?? '📦'}</span>
              {i.price && <span className="tag price">{i.price}</span>}
              {i.city !== 'Все города' && <span className="tag">📍 {i.city}</span>}
            </div>
            {i.description && <div className="d" style={{ marginTop: 4 }}>{i.description}</div>}
            {i.authorUsername && (
              <button
                className="link-row"
                onClick={() => openTg(`https://t.me/${i.authorUsername}`)}
              >
                Написать @{i.authorUsername}
              </button>
            )}
          </div>
        </div>
      ))}

      <div className="foot">
        Объявления собираются из темы «Барахолка» в чате проекта — там же их и размещают.
      </div>

      <div className="fab-bar">
        <button className="btn ghost" onClick={() => openTg(MARKET_TOPIC)}>
          💬 Открыть барахолку в чате
        </button>
      </div>
    </>
  )
}
