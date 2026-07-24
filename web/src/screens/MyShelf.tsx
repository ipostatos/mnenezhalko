import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Route } from '../App'
import type { ShelfBook, ShelfState } from '../types'
import { haptic, showAlert, showConfirm } from '../telegram'

const STATE: Record<ShelfState, { label: string; tone: string }> = {
  active: { label: 'На полке', tone: '#4caf72' },
  onloan: { label: 'На руках', tone: '#e0a13a' },
  pending: { label: 'На проверке', tone: '#50a8eb' },
  rejected: { label: 'Отклонена', tone: '#e5544b' },
  syncerror: { label: 'Ошибка синка', tone: '#c98a3a' },
  deleted: { label: 'Удалена', tone: '#8a9aa9' },
}

const ORDER: ShelfState[] = ['active', 'onloan', 'pending', 'rejected', 'syncerror', 'deleted']

export function MyShelf({ go, city }: { go: (r: Route) => void; city?: string }) {
  const [books, setBooks] = useState<ShelfBook[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  const load = () =>
    api
      .myShelf()
      .then((r) => setBooks(r.books))
      .catch((e) => setError(e.message))

  useEffect(() => {
    load()
  }, [])

  if (error) return <div className="error-banner">{error}</div>
  if (!books) return <div className="spinner">Загружаю полку…</div>

  const grouped = ORDER.map((s) => ({ state: s, items: books.filter((b) => b.state === s) })).filter(
    (g) => g.items.length,
  )

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

  return (
    <>
      <div className="hero">
        <span className="logo">🗂</span>
        <h1>Моя полка</h1>
      </div>

      {!books.length && (
        <div className="empty">
          <img className="illus sm" src="/il/bee.jpg" alt="" loading="lazy" />
          На вашей полке пока нет книг. Поделитесь своими — они станут видны соседям.
          <div style={{ height: 'var(--sp-5)' }} />
          <button className="btn" onClick={() => go({ name: 'add' })}>
            ➕ Добавить книгу
          </button>
        </div>
      )}

      {grouped.map((g) => (
        <div key={g.state}>
          <div className="section-title">
            {STATE[g.state].label} · {g.items.length}
          </div>
          {g.items.map((b) =>
            editing === b.id ? (
              <EditForm
                key={b.id}
                book={b}
                city={city}
                onCancel={() => setEditing(null)}
                onSaved={async () => {
                  setEditing(null)
                  await load()
                }}
              />
            ) : (
              <div key={b.id} className={`shelf-item${b.state === 'deleted' ? ' dim' : ''}`}>
                <div className="shelf-head">
                  <span className="badge" style={{ ['--tone' as any]: STATE[b.state].tone }}>
                    {STATE[b.state].label}
                  </span>
                  <div className="t-sm grow">{b.title}</div>
                </div>
                {(b.author || b.city) && (
                  <div className="d">
                    {[b.author, b.city && (b.district ? `${b.city} / ${b.district}` : b.city)]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                )}
                {b.state === 'rejected' && b.rejectionReason && (
                  <div className="shelf-note">Причина: {b.rejectionReason}</div>
                )}
                {b.state === 'pending' && (
                  <div className="shelf-note">Ждёт одобрения модератором.</div>
                )}
                {b.state === 'onloan' && (
                  <div className="shelf-note">Книга у читателя — см. «У кого моя книга».</div>
                )}
                {b.state === 'syncerror' && (
                  <div className="shelf-note">Не ушла в общую таблицу — админы это видят.</div>
                )}

                {b.state !== 'deleted' && (
                  <div className="shelf-actions">
                    {b.state === 'active' && (
                      <button className="btn sm" onClick={() => go({ name: 'book', id: b.id })}>
                        📖 В каталоге
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
                        ✏️ Изменить
                      </button>
                    )}
                    {b.state === 'rejected' && (
                      <button className="btn sm" disabled={busy === b.id} onClick={() => resubmit(b)}>
                        ♻️ Отправить снова
                      </button>
                    )}
                    <button className="btn sm ghost" disabled={busy === b.id} onClick={() => del(b)}>
                      🗑 {b.state === 'onloan' ? 'Скрыть' : 'Удалить'}
                    </button>
                  </div>
                )}
              </div>
            ),
          )}
        </div>
      ))}
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
    <div className="shelf-item">
      <div className="field">
        <label>Название</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label>Автор</label>
        <input value={author} onChange={(e) => setAuthor(e.target.value)} />
      </div>
      <div className="field">
        <label>Жанры (через запятую)</label>
        <input value={genres} onChange={(e) => setGenres(e.target.value)} />
      </div>
      <div className="field">
        <label>Языки (через запятую)</label>
        <input value={langs} onChange={(e) => setLangs(e.target.value)} />
      </div>
      <div className="field">
        <label>Город</label>
        <input value={place} onChange={(e) => setPlace(e.target.value)} />
      </div>
      <div className="shelf-actions">
        <button className="btn sm" disabled={saving} onClick={save}>
          {saving ? 'Сохраняю…' : 'Сохранить'}
        </button>
        <button className="btn sm ghost" disabled={saving} onClick={onCancel}>
          Отмена
        </button>
      </div>
    </div>
  )
}
