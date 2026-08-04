import { useEffect, useState } from 'react'
import { api } from '../api'
import type { EventItem, Me } from '../types'
import { openTg, showConfirm, haptic } from '../telegram'
import { useSeqGuard } from '../useSeqGuard'
import { SwipeRow } from './Swipe'
import { plural } from '../plural'

const fmt = new Intl.DateTimeFormat('ru-RU', {
  weekday: 'short',
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Warsaw',
})

/** Одна встреча: карточка одинаковая и в афише, и в блоке прошедших. */
function EventCard({ e }: { e: EventItem }) {
  return (
    <div className="row-card static">
      <div className="ic-tile" style={{ ['--tone' as any]: '#E2A336' }}>
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
  )
}

export function Events({ city, me }: { city?: string; me?: Me | null }) {
  const [events, setEvents] = useState<EventItem[] | null>(null)
  const [past, setPast] = useState<EventItem[] | null>(null)
  const [onlyMyCity, setOnlyMyCity] = useState(Boolean(city))
  const guard = useSeqGuard()
  const isAdmin = Boolean(me?.user.isAdmin)

  useEffect(() => {
    // тумблер города: старый медленный ответ не перетирает новый фильтр
    const id = guard.next()
    api
      .events(onlyMyCity ? city : undefined)
      .then((r) => guard.isCurrent(id) && setEvents(r))
      .catch(() => guard.isCurrent(id) && setEvents([]))
  }, [city, onlyMyCity])

  useEffect(() => {
    // блок уборки: спрятанные кнопки защитой не считаются, права проверяет
    // сервер на самой ручке — здесь просто не дёргаем её лишний раз
    if (!isAdmin) return setPast(null)
    api
      .pastEvents(onlyMyCity ? city : undefined)
      .then(setPast)
      .catch(() => setPast([]))
  }, [city, onlyMyCity, isAdmin])

  async function remove(e: EventItem) {
    const ok = await showConfirm(
      `Убрать встречу «${e.title}» от ${fmt.format(new Date(e.startsAt))}?\n\n` +
        'Она пропадёт из афиши у всех. Сообщение в чате останется на месте.',
    )
    if (!ok) return
    try {
      await api.removeEvent(e.id)
      haptic('success')
      setPast((list) => (list ?? []).filter((x) => x.id !== e.id))
    } catch {
      // список мог устареть: перечитываем, чтобы экран не расходился с базой
      api.pastEvents(onlyMyCity ? city : undefined).then(setPast).catch(() => {})
    }
  }

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

      {events?.map((e) => <EventCard key={e.id} e={e} />)}

      {isAdmin && past !== null && past.length > 0 && (
        <details className="past-events">
          <summary>
            Прошедшие · {past.length} {plural(past.length, ['встреча', 'встречи', 'встреч'])}
          </summary>
          <div className="past-hint">
            Свайп влево по встрече открывает корзину. Убранная встреча пропадёт из афиши
            у всех, сообщение в чате останется.
          </div>
          {past.map((e) => (
            <SwipeRow key={e.id} onAction={() => remove(e)} label={`Убрать «${e.title}»`}>
              <EventCard e={e} />
            </SwipeRow>
          ))}
        </details>
      )}
    </>
  )
}
