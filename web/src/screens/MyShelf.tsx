import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Route } from '../App'
import type { ShelfBook, ShelfState } from '../types'
import { haptic, showAlert, showConfirm, onAppShow } from '../telegram'
import { useSeqGuard } from '../useSeqGuard'
import { Icon } from './Icon'
import { Badges } from './Badges'

/* Тона состояний берём из фирменной палитры (см. :root в styles.css), а не
   произвольные яркие — иначе бейджи выбиваются из нежного крем-персика. */
const STATE: Record<ShelfState, { label: string; tone: string }> = {
  active: { label: 'На полке', tone: '#5a9d6b' }, // --ok
  onloan: { label: 'На руках', tone: '#d98a62' }, // --terracotta
  pending: { label: 'На проверке', tone: '#6d8fb5' }, // приглушённый sky
  rejected: { label: 'Отклонена', tone: '#d9584b' }, // --bad
  syncerror: { label: 'Ошибка синка', tone: '#e0a44a' }, // --honey
  deleted: { label: 'Удалена', tone: '#8f8578' }, // --hint
}

const ORDER: ShelfState[] = ['active', 'onloan', 'pending', 'rejected', 'syncerror', 'deleted']

export function MyShelf({ go, city }: { go: (r: Route) => void; city?: string }) {
  const [books, setBooks] = useState<ShelfBook[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const guard = useSeqGuard()

  // ошибка сбрасывается перед каждой загрузкой и после успеха: раньше один
  // моргнувший запрос оставлял баннер ошибки до полного перезапуска Mini App
  const load = () => {
    const id = guard.next()
    setError('')
    return api
      .myShelf()
      .then((r) => {
        if (!guard.isCurrent(id)) return
        setBooks(r.books)
        setError('')
      })
      .catch((e) => {
        if (guard.isCurrent(id)) setError(e.message)
      })
  }

  useEffect(() => {
    load()
    return onAppShow(load)
  }, [])

  if (error && !books) {
    return (
      <div className="empty">
        <div className="error-banner">{error}</div>
        <button className="btn" onClick={load}>
          Попробовать ещё раз
        </button>
      </div>
    )
  }
  if (!books) return <div className="spinner">Загружаю полку…</div>

  // поиск по своей полке: название, автор, тип — группировка статусов сохраняется
  const needle = q.trim().toLowerCase()
  const matches = (b: ShelfBook) =>
    !needle ||
    b.title.toLowerCase().includes(needle) ||
    (b.author ?? '').toLowerCase().includes(needle) ||
    (b.kind === 'game' && 'настолка'.includes(needle)) ||
    STATE[b.state].label.toLowerCase().includes(needle)
  const grouped = ORDER.map((s) => ({
    state: s,
    items: books.filter((b) => b.state === s && matches(b)),
  })).filter((g) => g.items.length)

  async function del(b: ShelfBook) {
    if (b.state === 'onloan') {
      if (!(await showConfirm(`«${b.title}» сейчас на руках. Скрыть её с полки после возврата?`)))
        return
      setBusy(b.id)
      try {
        await api.deleteBook(b.id, true)
        haptic('success')
        showAlert('Скрою книгу, как только её вернут.')
        await load()
      } catch (e: any) {
        showAlert(e.message)
      } finally {
        setBusy(null)
      }
      return
    }
    if (!(await showConfirm(`Удалить «${b.title}»? Книга исчезнет с полки и из каталога.`))) return
    setBusy(b.id)
    try {
      await api.deleteBook(b.id)
      haptic('success')
      await load()
    } catch (e: any) {
      showAlert(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function resubmit(b: ShelfBook) {
    setBusy(b.id)
    try {
      const r = await api.resubmitBook(b.id)
      haptic('success')
      showAlert(r.pending ? 'Отправил на проверку заново.' : 'Книга снова в каталоге.')
      await load()
    } catch (e: any) {
      showAlert(e.message)
    } finally {
      setBusy(null)
    }
  }

  const editingBook = editing ? books.find((b) => b.id === editing) : null
  if (editingBook) {
    return (
      <EditForm
        book={editingBook}
        city={city}
        onCancel={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null)
          await load()
        }}
      />
    )
  }

  const count = (s: ShelfState) => books.filter((b) => b.state === s).length

  return (
    <>
      <h1>Моя полка</h1>
      <div className="sub">Ваши книги, их состояние и правки — в одном месте</div>

      {books.length > 0 && (
        <div className="stat-tiles">
          <div className="s">
            <div className="n">{count('active')}</div>
            <div className="c">на полке</div>
          </div>
          <div className="s">
            <div className="n">{count('onloan')}</div>
            <div className="c">на руках</div>
          </div>
          <div className="s">
            <div className="n">{count('pending')}</div>
            <div className="c">на проверке</div>
          </div>
        </div>
      )}

      {books.length > 0 && <Badges />}

      {books.length > 3 && (
        <input
          className="input"
          placeholder="Поиск по полке: название, автор…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ marginBottom: 'var(--sp-4)' }}
        />
      )}

      {books.length > 0 && grouped.length === 0 && (
        <div className="empty">Ничего не нашлось на полке. Попробуйте другое слово.</div>
      )}

      {!books.length && (
        <div className="empty">
          <img className="illus sm" src="/il/bee.jpg" alt="" loading="lazy" />
          На вашей полке пока нет книг. Поделитесь своими — они станут видны библиотекарям.
          <div style={{ height: 'var(--sp-5)' }} />
          <button className="btn" onClick={() => go({ name: 'add' })}>
            <Icon name="plus" /> Добавить книгу
          </button>
        </div>
      )}

      {grouped.map((g) => (
        <div key={g.state}>
          <div className="section-title">
            {STATE[g.state].label} · {g.items.length}
          </div>
          {g.items.map((b) => (
            <div
              key={b.id}
              className={`shelf-card${b.state === 'deleted' ? ' dim' : ''}`}
              style={{ ['--tone' as any]: STATE[b.state].tone }}
            >
              <div className="shelf-top">
                <div className="cover">
                  {b.coverUrl ? (
                    <img src={b.coverUrl} alt="" loading="lazy" />
                  ) : (
                    b.title.slice(0, 1).toUpperCase()
                  )}
                </div>
                <div className="grow">
                  <div className="shelf-title">{b.title}</div>
                  {(b.author || b.city) && (
                    <div className="shelf-meta">
                      {[b.author, b.city && (b.district ? `${b.city} / ${b.district}` : b.city)]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  )}
                  {/* состояние читается по цветной полосе слева и заголовку группы —
                      бейдж на самой карточке был бы третьим повтором того же */}
                  {b.kind === 'game' && (
                    <div className="market-meta">
                      <span className="tag">настолка</span>
                    </div>
                  )}
                </div>
              </div>

              {b.state === 'rejected' && b.rejectionReason && (
                <div className="shelf-note">Причина: {b.rejectionReason}</div>
              )}
              {b.state === 'pending' && <div className="shelf-note">Ждёт одобрения модератором.</div>}
              {b.state === 'onloan' && (
                <div className="shelf-note">Книга у читателя — см. «У кого моя книга».</div>
              )}
              {/* очередь видна владельцу числом: кто именно ждёт — не его дело
                  и не наше (см. server/src/waitlist.ts) */}
              {!!b.waitCount && (
                <div className="shelf-note wait-count">
                  {b.waitCount === 1 ? 'Эту книгу ждёт 1 человек' : `Эту книгу ждут: ${b.waitCount}`}
                </div>
              )}
              {b.state === 'syncerror' && (
                <div className="shelf-note">Не ушла в общую таблицу — админы это видят.</div>
              )}

              {b.state !== 'deleted' && (
                <div className="shelf-actions">
                  {b.state === 'active' && (
                    <button className="btn sm" onClick={() => go({ name: 'book', id: b.id })}>
                      <Icon name="book" /> В каталоге
                    </button>
                  )}
                  {b.state === 'rejected' && (
                    <button className="btn sm" disabled={busy === b.id} onClick={() => resubmit(b)}>
                      <Icon name="refresh" /> Отправить снова
                    </button>
                  )}
                  {(b.state === 'active' ||
                    b.state === 'pending' ||
                    b.state === 'rejected' ||
                    b.state === 'syncerror') && (
                    <button
                      className="btn sm ghost"
                      onClick={() => {
                        haptic()
                        setEditing(b.id)
                      }}
                    >
                      <Icon name="edit" /> Изменить
                    </button>
                  )}
                  <button
                    className="btn sm ghost narrow"
                    disabled={busy === b.id}
                    onClick={() => del(b)}
                  >
                    <Icon name={b.state === 'onloan' ? 'hide' : 'trash'} />{' '}
                    {b.state === 'onloan' ? 'Скрыть' : 'Удалить'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}

      {books.length > 0 && (
        <button
          className="promo"
          onClick={() => {
            haptic()
            go({ name: 'add' })
          }}
        >
          <img src="/il/add.jpg" alt="" loading="lazy" />
          <div className="grow">
            <div className="t">Добавить ещё книгу</div>
            <div className="d">Она останется у вас — просто станет видна библиотекарям</div>
          </div>
          <div className="chev">›</div>
        </button>
      )}
    </>
  )
}

/** Инлайн-форма правки книги: название, автор, жанры, языки, город. */
function EditForm({
  book,
  city,
  onCancel,
  onSaved,
}: {
  book: ShelfBook
  city?: string
  onCancel: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(book.title)
  const [author, setAuthor] = useState(book.author ?? '')
  const [genres, setGenres] = useState(book.genres.join(', '))
  const [langs, setLangs] = useState(book.languages.join(', '))
  const [place, setPlace] = useState(book.city ?? city ?? '')
  const [saving, setSaving] = useState(false)

  const list = (s: string) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)

  async function save() {
    if (title.trim().length < 2) return showAlert('Название слишком короткое.')
    setSaving(true)
    try {
      await api.editBook(book.id, {
        title: title.trim(),
        author: author.trim() || null,
        genres: list(genres),
        languages: list(langs),
        city: place.trim() || null,
      })
      haptic('success')
      onSaved()
    } catch (e: any) {
      showAlert(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <h1>Редактирование</h1>
      <div className="sub">
        {book.state === 'active' || book.state === 'onloan'
          ? 'Правки уедут и в общую таблицу проекта'
          : 'Книги ещё нет в общей таблице — правки останутся здесь'}
      </div>

      {book.coverUrl ? (
        <img className="edit-cover" src={book.coverUrl} alt="" />
      ) : (
        <div className="edit-cover placeholder">{book.title.slice(0, 1).toUpperCase()}</div>
      )}

      <div className="field">
        <label>Название</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label>Автор</label>
        <input className="input" value={author} onChange={(e) => setAuthor(e.target.value)} />
      </div>
      <div className="field">
        <label>Жанры</label>
        <input
          className="input"
          placeholder="через запятую"
          value={genres}
          onChange={(e) => setGenres(e.target.value)}
        />
      </div>
      <div className="field">
        <label>Языки</label>
        <input
          className="input"
          placeholder="через запятую"
          value={langs}
          onChange={(e) => setLangs(e.target.value)}
        />
      </div>
      <div className="field">
        <label>Город</label>
        <input className="input" value={place} onChange={(e) => setPlace(e.target.value)} />
      </div>

      <div style={{ height: 'var(--sp-3)' }} />
      <button className="btn" disabled={saving} onClick={save}>
        {saving ? 'Сохраняю…' : 'Сохранить'}
      </button>
      <div style={{ height: 'var(--sp-2)' }} />
      <button className="btn ghost" disabled={saving} onClick={onCancel}>
        Отмена
      </button>
    </>
  )
}
