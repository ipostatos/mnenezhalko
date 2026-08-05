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

/**
 * Подробности встречи (B4, ТЗ 5.08.2026). Раньше карточка была неподвижной
 * плашкой: человек видел дату и описание, но не понимал, куда нажать и как
 * присоединиться. Теперь карточка целиком — кнопка, а здесь всё, что о встрече
 * известно, и ТОЛЬКО те действия, которые действительно работают. Кнопки
 * «Я пойду» нет намеренно: пока участие негде хранить, она бы ничего не
 * сохраняла (модель EventAttendance вынесена отдельной задачей).
 */
function EventSheet({ e, onClose }: { e: EventItem; onClose: () => void }) {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => ev.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-label={`Встреча: ${e.title}`}
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="sheet-head">
          <div className="t">{e.title}</div>
          <button className="sheet-close" aria-label="Закрыть" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="sheet-body">
          <div className="d">{fmt.format(new Date(e.startsAt))}</div>
          <div className="d">
            {e.city}
            {e.place ? `, ${e.place}` : ''}
          </div>
          {e.description && (
            <p className="lead" style={{ marginTop: 'var(--sp-3)' }}>
              {e.description}
            </p>
          )}

          {e.url && (
            <button
              className="btn"
              style={{ marginTop: 'var(--sp-4)' }}
              onClick={() => openTg(e.url!)}
            >
              Открыть страницу встречи
            </button>
          )}
          {e.sourceUrl && (
            <button
              className={`btn ${e.url ? 'ghost' : ''}`}
              style={{ marginTop: 'var(--sp-3)' }}
              onClick={() => openTg(e.sourceUrl!)}
            >
              Открыть афишу в чате
            </button>
          )}
          {/* ни своей страницы, ни афиши — молчим, а не рисуем мёртвую кнопку */}
          {!e.url && !e.sourceUrl && (
            <div className="muted" style={{ marginTop: 'var(--sp-4)' }}>
              Подробности спросите в чате своего города — там же договариваются о месте.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Одна встреча: карточка одинаковая и в афише, и в блоке прошедших. */
function EventCard({ e }: { e: EventItem }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        className="row-card"
        aria-label={`${e.title}, подробнее`}
        onClick={() => {
          haptic()
          setOpen(true)
        }}
      >
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
          {e.description && (
            <div className="d" style={{ marginTop: 4 }}>
              {e.description}
            </div>
          )}
          <div className="d">Подробнее</div>
        </div>
        <div className="chev">›</div>
      </button>
      {open && <EventSheet e={e} onClose={() => setOpen(false)} />}
    </>
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
