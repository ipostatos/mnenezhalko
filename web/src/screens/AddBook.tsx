import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Route } from '../App'
import type { Facets } from '../types'
import { haptic, showAlert } from '../telegram'

const CITIES = [
  'Warszawa',
  'Kraków',
  'Wrocław',
  'Poznań',
  'Trójmiasto',
  'Łódź',
  'Białystok',
  'Olsztyn',
  'Radom',
]

const LANGS = ['Русский', 'Polski', 'English', 'Українська', 'Беларуская']

export function AddBook({ city, go }: { city?: string; go: (r: Route) => void }) {
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [genres, setGenres] = useState<string[]>([])
  const [langs, setLangs] = useState<string[]>(['Русский'])
  const [place, setPlace] = useState(city ?? '')
  const [kind, setKind] = useState('book')
  const [facets, setFacets] = useState<Facets | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedId, setSavedId] = useState<string | null>(null)

  useEffect(() => {
    api.facets().then(setFacets).catch(() => {})
  }, [])

  const toggle = (arr: string[], set: (v: string[]) => void, value: string) =>
    set(arr.includes(value) ? arr.filter((x) => x !== value) : [...arr, value])

  async function save() {
    setSaving(true)
    try {
      const res = await api.addBook({
        title: title.trim(),
        author: author.trim() || undefined,
        genres: genres.join(', '),
        languages: langs.join(', '),
        city: place || undefined,
        kind,
      })
      haptic('success')
      setSavedId(res.book.id)
    } catch (e: any) {
      showAlert(e.message === 'unauthorized' ? 'Откройте приложение через бота' : e.message)
    } finally {
      setSaving(false)
    }
  }

  if (savedId) {
    return (
      <div className="empty">
        <div className="big">🎉</div>
        Книга на полке! Теперь её видно в поиске, а с вами свяжутся напрямую в Telegram.
        <div style={{ height: 'var(--sp-5)' }} />
        <button className="btn" onClick={() => go({ name: 'book', id: savedId })}>
          Посмотреть карточку
        </button>
        <div style={{ height: 'var(--sp-2)' }} />
        <button
          className="btn ghost"
          onClick={() => {
            setSavedId(null)
            setTitle('')
            setAuthor('')
          }}
        >
          Добавить ещё одну
        </button>
      </div>
    )
  }

  return (
    <>
      <h1>Добавить на полку</h1>
      <div className="sub">Книга останется у вас — просто станет видна соседям.</div>

      <div className="segmented">
        <button className={kind === 'book' ? 'active' : ''} onClick={() => setKind('book')}>
          Книга
        </button>
        <button className={kind === 'game' ? 'active' : ''} onClick={() => setKind('game')}>
          Настолка
        </button>
      </div>

      <div className="field-group">
        <input
          className="input"
          placeholder="Название *"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        {kind === 'book' && (
          <input
            className="input"
            placeholder="Автор"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          />
        )}
      </div>

      <div className="section-title">Город</div>
      <div className="chips" style={{ marginBottom: 'var(--sp-4)' }}>
        {CITIES.map((c) => (
          <button
            key={c}
            className={`chip sm ${place.startsWith(c) ? 'active' : ''}`}
            onClick={() => setPlace(c)}
          >
            {c}
          </button>
        ))}
      </div>

      {kind === 'book' && (
        <>
          <div className="section-title">Язык</div>
          <div className="chips" style={{ marginBottom: 'var(--sp-4)' }}>
            {LANGS.map((l) => (
              <button
                key={l}
                className={`chip sm ${langs.includes(l) ? 'active' : ''}`}
                onClick={() => toggle(langs, setLangs, l)}
              >
                {l}
              </button>
            ))}
          </div>

          <div className="section-title">Жанры</div>
          <div className="chips" style={{ marginBottom: 'var(--sp-5)' }}>
            {(facets?.genres ?? []).slice(0, 18).map((g) => (
              <button
                key={g.value}
                className={`chip sm ${genres.includes(g.value) ? 'active' : ''}`}
                onClick={() => toggle(genres, setGenres, g.value)}
              >
                {g.value}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="fab-bar">
        <button className="btn" disabled={saving || title.trim().length < 2} onClick={save}>
          {saving ? 'Сохраняю…' : 'Поставить на полку'}
        </button>
      </div>
    </>
  )
}
