import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Route } from '../App'
import type { DupCheck, Facets } from '../types'
import { haptic, showAlert, showConfirm } from '../telegram'

/** Русское склонение по числу. */
const plural = (n: number, forms: [string, string, string]) => {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return forms[0]
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return forms[1]
  return forms[2]
}

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
  const [dup, setDup] = useState<DupCheck | null>(null)
  /** книги, которые видно на том же фото, но мастер ведёт по одной */
  const [extra, setExtra] = useState<{ title: string; author: string | null }[]>([])
  const [isbn, setIsbn] = useState('')
  const [isbnBusy, setIsbnBusy] = useState(false)
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
      setDup(res.dup)
      setExtra(res.extraBooks ?? [])

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

  /** Поиск по ISBN: заполняет название, автора и обложку из открытых каталогов. */
  async function findByIsbn() {
    const code = isbn.trim()
    if (!code) return
    setIsbnBusy(true)
    setHint(null)
    try {
      const r = await api.isbn(code)
      if (!r.book) {
        // русские издания открытые каталоги знают плохо — говорим прямо, а не «ничего не найдено»
        showAlert(
          r.quotaBlocked
            ? 'По этому ISBN ничего не нашлось: открытые каталоги знают в основном англо- и польскоязычные издания. Сфотографируйте обложку — распознаю по ней.'
            : 'По этому ISBN ничего не нашлось. Сфотографируйте обложку или заполните поля руками.',
        )
        return
      }
      setTitle(r.book.title)
      if (r.book.author) setAuthor(r.book.author)
      if (r.book.coverUrl) setCover(r.book.coverUrl)
      haptic('success')
      setHint('Заполнил по ISBN — проверьте язык и жанры.')
      api
        .duplicates(r.book.title, r.book.author ?? undefined, kind)
        .then(setDup)
        .catch(() => {})
    } catch (e: any) {
      showAlert(e.message === 'bad_isbn' ? 'Это не похоже на ISBN — 10 или 13 цифр.' : e.message)
    } finally {
      setIsbnBusy(false)
    }
  }

  async function save() {
    // свой дубль — предупреждаем и просим подтвердить (чужие экземпляры не мешают)
    const check = await api.duplicates(title.trim(), author.trim() || undefined, kind).catch(() => null)
    if (
      check?.own &&
      !(await showConfirm(
        `У вас на полке уже есть «${check.own.title}». Всё равно добавить ещё один экземпляр?`,
      ))
    ) {
      return
    }
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
            setDup(null)
          }}
        >
          Добавить ещё одну
        </button>
      </div>
    )
  }

  return (
    <>
      <img className="illus" src="/il/add.jpg" alt="" loading="lazy" />
      <h1>Добавить на полку</h1>
      <div className="sub">Книга останется у вас — просто станет видна библиотекарям.</div>

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

      {/* второй путь заполнения: номер с задней обложки */}
      <div className="isbn-row">
        <input
          className="input"
          placeholder="или ISBN с задней обложки"
          inputMode="numeric"
          value={isbn}
          onChange={(e) => setIsbn(e.target.value)}
        />
        <button
          className="btn sm"
          disabled={isbnBusy || isbn.trim().length < 10}
          onClick={findByIsbn}
        >
          {isbnBusy ? 'Ищу…' : 'Найти'}
        </button>
      </div>

      {dup?.own && (
        <div className="warn-banner">
          ⚠️ Такая книга уже есть на вашей полке — «{dup.own.title}». Добавляйте, только если это
          второй экземпляр.
        </div>
      )}
      {!dup?.own && dup && dup.others.count > 0 && (
        <div className="note">
          📚 В библиотеке уже есть ещё {dup.others.count}{' '}
          {plural(dup.others.count, ['экземпляр', 'экземпляра', 'экземпляров'])}
          {/* именно разбивка по городам: общее число рядом с одним городом врало,
              когда экземпляры стоят в разных городах */}
          {dup.others.where ? ` — ${dup.others.where}` : ''} — это нормально, добавляйте свой.
        </div>
      )}

      {extra.length > 0 && (
        <div className="note">
          👀 На фото видно ещё {extra.length}{' '}
          {plural(extra.length, ['книгу', 'книги', 'книг'])}: {extra.map((b) => b.title).join(', ')}.
          <br />
          Здесь добавляется одна книга за раз. Чтобы поставить на полку сразу все — пришлите это же
          фото боту, он добавит их одним списком.
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
