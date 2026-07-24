import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Route } from '../App'
import type { Book, Facets } from '../types'
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

/**
 * Сжимает снимок до 1280px по длинной стороне — этого хватает, чтобы прочитать
 * обложку, и запрос остаётся лёгким на мобильном интернете.
 */
async function compress(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.82)
}

export function AddBook({ city, go }: { city?: string; go: (r: Route) => void }) {
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [genres, setGenres] = useState<string[]>([])
  const [langs, setLangs] = useState<string[]>(['Русский'])
  const [place, setPlace] = useState(city ?? '')
  const [district, setDistrict] = useState('')
  const [kind, setKind] = useState('book')
  const [facets, setFacets] = useState<Facets | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<{ id: string; inNotion: boolean; pending: boolean } | null>(
    null,
  )

  const [cover, setCover] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const [duplicates, setDuplicates] = useState<Book[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.facets().then(setFacets).catch(() => {})
  }, [])

  const toggle = (arr: string[], set: (v: string[]) => void, value: string) =>
    set(arr.includes(value) ? arr.filter((x) => x !== value) : [...arr, value])

  async function onPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    setScanning(true)
    setHint(null)
    try {
      const image = await compress(file)
      setCover(image)
      const res = await api.recognize(image)
      setCover(res.cover)
      setDuplicates(res.duplicates)

      const r = res.recognized
      if (!r || !r.recognized || !r.title) {
        setHint(r?.note || 'Не разобрал обложку — заполните поля руками.')
        return
      }
      setKind(r.kind)
      setTitle(r.title)
      setAuthor(r.author ?? '')
      if (r.genres.length) setGenres(r.genres)
      if (r.languages.length) setLangs(r.languages)
      haptic('success')
      setHint(
        r.confidence === 'high'
          ? 'Заполнил по фото — проверьте и сохраняйте.'
          : r.note || 'Фото читается не идеально, проверьте название и автора.',
      )
    } catch (err: any) {
      const messages: Record<string, string> = {
        image_too_big: 'Фото слишком большое, попробуйте ещё раз.',
        unsupported_image: 'Такой формат картинки не поддерживается.',
        bad_image: 'Не удалось прочитать фото.',
        unauthorized: 'Откройте приложение через бота',
      }
      showAlert(messages[err.message] ?? err.message)
      setCover(null)
    } finally {
      setScanning(false)
    }
  }

  async function save() {
    setSaving(true)
    try {
      const res = await api.addBook({
        title: title.trim(),
        author: author.trim() || undefined,
        genres: genres.join(', '),
        languages: langs.join(', '),
        city: place || undefined,
        district: district.trim() || undefined,
        kind,
        // сюда приходит либо ссылка от распознавания, либо снимок без него
        coverUrl: cover && !cover.startsWith('data:') ? cover : undefined,
        coverImage: cover && cover.startsWith('data:') ? cover : undefined,
      })
      haptic('success')
      setSaved({
        id: res.book.id,
        inNotion: res.notionStatus === 'synced',
        pending: res.book.reviewStatus === 'pending',
      })
    } catch (e: any) {
      showAlert(e.message === 'unauthorized' ? 'Откройте приложение через бота' : e.message)
    } finally {
      setSaving(false)
    }
  }

  if (saved) {
    return (
      <div className="empty">
        <div className="big">{saved.pending ? '📖' : '🎉'}</div>
        {saved.pending ? (
          <>
            Книга отправлена на проверку модератору. Как одобрят — она появится в библиотеке, и бот
            вам сообщит.
          </>
        ) : (
          <>
            Книга на полке! Теперь её видно в поиске, а с вами свяжутся напрямую в Telegram.
            <div className="sub" style={{ marginTop: 'var(--sp-2)' }}>
              {saved.inNotion
                ? 'Карточка уже в общей таблице проекта.'
                : 'В общую таблицу проекта карточка уйдёт чуть позже — админы получили уведомление.'}
            </div>
          </>
        )}
        <div style={{ height: 'var(--sp-5)' }} />
        {!saved.pending && (
          <button className="btn" onClick={() => go({ name: 'book', id: saved.id })}>
            Посмотреть карточку
          </button>
        )}
        <div style={{ height: 'var(--sp-2)' }} />
        <button
          className="btn ghost"
          onClick={() => {
            setSaved(null)
            setTitle('')
            setAuthor('')
            setCover(null)
            setHint(null)
            setDuplicates([])
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

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={onPhoto}
      />

      <div className="scan-card">
        {cover ? (
          <img className="scan-cover" src={cover} alt="" />
        ) : (
          <div className="scan-placeholder">📷</div>
        )}
        <div className="scan-body">
          <button
            className="btn"
            disabled={scanning}
            onClick={() => fileRef.current?.click()}
          >
            {scanning ? 'Смотрю на обложку…' : cover ? 'Другое фото' : 'Сфотографировать книгу'}
          </button>
          <div className="sub" style={{ marginTop: 'var(--sp-2)' }}>
            {hint ?? 'Сниму название, автора, язык и жанр с обложки.'}
          </div>
        </div>
      </div>

      {duplicates.length > 0 && (
        <div className="note">
          Такая книга уже есть в библиотеке:
          {duplicates.map((b) => (
            <button key={b.id} className="link-row" onClick={() => go({ name: 'book', id: b.id })}>
              {b.title}
              {b.owner ? ` — ${b.owner.name}` : ''}
            </button>
          ))}
          Всё равно можно добавить свою — экземпляров бывает несколько.
        </div>
      )}

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
      <div className="chips" style={{ marginBottom: 'var(--sp-3)' }}>
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
      <div className="field-group" style={{ marginBottom: 'var(--sp-4)' }}>
        <input
          className="input"
          placeholder="Район — например Wola (необязательно)"
          value={district}
          onChange={(e) => setDistrict(e.target.value)}
        />
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
        <button
          className="btn"
          disabled={saving || scanning || title.trim().length < 2}
          onClick={save}
        >
          {saving ? 'Сохраняю…' : 'Поставить на полку'}
        </button>
      </div>
    </>
  )
}
