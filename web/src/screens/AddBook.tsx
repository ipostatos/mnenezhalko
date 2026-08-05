import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { Route } from '../App'
import type { DupCheck, Facets, LibrarianPick } from '../types'
import { haptic, showAlert, showConfirm } from '../telegram'
import { plural } from '../plural'
import { TagPicker } from './TagPicker'

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

/**
 * Пока справочник с сервера не пришёл, показываем самые частые языки проекта —
 * иначе форма на секунду выглядит сломанной. Полный список (и жанры) приходит
 * из Notion в /api/facets, см. server/src/taxonomy.ts.
 */
const LANGS_FALLBACK = ['Русский', 'Polski', 'English', 'Українська', 'Беларуская']

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

export function AddBook({
  city,
  go,
  isAdmin = false,
}: {
  city?: string
  go: (r: Route) => void
  /** админам и модераторам доступен выбор «чья это книга» */
  isAdmin?: boolean
}) {
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [genres, setGenres] = useState<string[]>([])
  const [langs, setLangs] = useState<string[]>(['Русский'])
  const [place, setPlace] = useState(city ?? '')
  const [district, setDistrict] = useState('')
  const [kind, setKind] = useState('book')
  const [facets, setFacets] = useState<Facets | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<{
    id: string
    inNotion: boolean
    pending: boolean
    /** имя библиотекаря, если книгу вносили за него */
    owner: string | null
    /** объяснение исхода модерации — текст приходит с сервера, своего не пишем */
    moderationNotice: string | null
  } | null>(null)

  const [cover, setCover] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const [dup, setDup] = useState<DupCheck | null>(null)
  /** книги, которые видно на том же фото, но мастер ведёт по одной */
  const [extra, setExtra] = useState<{ title: string; author: string | null }[]>([])
  const [isbn, setIsbn] = useState('')
  const [isbnBusy, setIsbnBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  /**
   * «Чья это книга» — только у админов и модераторов.
   *
   * Человек может не иметь возможности внести свои книги сам (нет Telegram под
   * рукой, не разобрался, попросил на встрече). Раньше такие книги оседали на
   * полке админа и номинально становились его — теперь владелец выбирается
   * явно, а в аудите остаётся, кто именно внёс (просьба user 4.08.2026).
   */
  const [owner, setOwner] = useState<LibrarianPick | null>(null)
  const [ownerQuery, setOwnerQuery] = useState('')
  const [ownerHits, setOwnerHits] = useState<LibrarianPick[]>([])

  useEffect(() => {
    if (!isAdmin || owner) return
    const q = ownerQuery.trim()
    if (q.length < 2) {
      setOwnerHits([])
      return
    }
    // подсказки не должны лететь на каждую букву
    const t = setTimeout(() => {
      api
        .adminLibrarians(q)
        .then((r) => setOwnerHits(r.librarians))
        .catch(() => setOwnerHits([]))
    }, 250)
    return () => clearTimeout(t)
  }, [ownerQuery, owner, isAdmin])

  useEffect(() => {
    api.facets().then(setFacets).catch(() => {})
  }, [])

  /**
   * Порядок жанров: сначала самые ходовые в каталоге, следом весь справочник
   * Notion. Так частый жанр остаётся в один тап, а редкий всё-таки доступен —
   * раньше в форме было только 18 самых частых, и остальное было не выбрать.
   */
  const genreOptions = useMemo(() => {
    const all = facets?.genreOptions ?? []
    if (!all.length) return (facets?.genres ?? []).map((g) => g.value)
    const known = new Set(all)
    const popular = (facets?.genres ?? []).map((g) => g.value).filter((v) => known.has(v))
    return [...new Set([...popular, ...all])]
  }, [facets])

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
        // «каталог не отвечает» и «книги нет» — разные новости, и совет разный
        showAlert(
          r.serviceDown
            ? 'Каталог книг сейчас не отвечает. Попробуйте ещё раз через минуту или сфотографируйте обложку.'
            : r.quotaBlocked
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
    // свой дубль — предупреждаем и просим подтвердить (чужие экземпляры не мешают).
    // Когда книгу вносят за человека, «свой» — это его дубль, а не наш
    const check = await api
      .duplicates(title.trim(), author.trim() || undefined, kind, owner?.id)
      .catch(() => null)
    if (
      check?.own &&
      !(await showConfirm(
        owner
          ? `У ${owner.name} на полке уже есть «${check.own.title}». Всё равно добавить ещё один экземпляр?`
          : `У вас на полке уже есть «${check.own.title}». Всё равно добавить ещё один экземпляр?`,
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
        ownerLibrarianId: owner?.id,
      })
      haptic('success')
      setSaved({
        id: res.book.id,
        inNotion: res.notionStatus === 'synced',
        pending: res.moderation?.state === 'pending',
        owner: owner?.name ?? null,
        moderationNotice: res.moderationNotice ?? null,
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
          /* формулировку даёт сервер (publish.ts::moderationNotice): одно правило —
             один текст и в боте, и здесь */
          <>{saved.moderationNotice}</>
        ) : (
          <>
            {saved.owner ? (
              <>
                Книга на полке: {saved.owner}. Теперь её видно в поиске, а писать по ней будут
                владельцу.
              </>
            ) : (
              <>Книга на полке! Теперь её видно в поиске, а с вами свяжутся напрямую в Telegram.</>
            )}
            <div className="sub" style={{ marginTop: 'var(--sp-2)' }}>
              {saved.inNotion
                ? 'Карточка уже в общей таблице проекта.'
                : 'В общую таблицу проекта карточка уйдёт чуть позже — админы получили уведомление.'}
            </div>
            {/* при включённой модерации админ публикует книгу сам — молча это
                выглядит как «проверка не работает» (вопрос user 5.08.2026) */}
            {saved.moderationNotice && (
              <div className="sub" style={{ marginTop: 'var(--sp-2)' }}>
                {saved.moderationNotice}
              </div>
            )}
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
      <div className="sub">
        {owner
          ? `Книга встанет на полку: ${owner.name}${owner.city ? ` · ${owner.city}` : ''}. Писать по ней будут владельцу, не вам.`
          : 'Книга останется у вас — просто станет видна библиотекарям.'}
      </div>

      {/* выбор владельца — только админам и модераторам: вносим книги за того,
          кто не может сделать это сам, чтобы они не оседали на нашей полке */}
      {isAdmin && (
        <div className="card behalf">
          <div className="section-title" style={{ margin: '0 0 var(--sp-2)' }}>
            Чья это книга
          </div>
          {owner ? (
            <div className="behalf-picked">
              <div className="grow">
                <div className="t-sm">{owner.name}</div>
                <div className="d muted">
                  {[owner.telegram ? `@${owner.telegram}` : null, owner.city, `${owner.books} на полке`]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <button
                className="btn ghost sm narrow"
                onClick={() => {
                  haptic()
                  setOwner(null)
                  setOwnerQuery('')
                }}
              >
                Убрать
              </button>
            </div>
          ) : (
            <>
              <input
                className="input"
                placeholder="Имя или @ник библиотекаря"
                value={ownerQuery}
                onChange={(e) => setOwnerQuery(e.target.value)}
              />
              {ownerHits.length > 0 && (
                <div className="behalf-hits">
                  {ownerHits.map((l) => (
                    <button
                      key={l.id}
                      className="behalf-hit"
                      onClick={() => {
                        haptic()
                        setOwner(l)
                        setOwnerHits([])
                        // город книги — города владельца: свой подставлять нельзя
                        if (l.city) setPlace(l.city)
                      }}
                    >
                      <span className="t-sm">{l.name}</span>
                      <span className="d muted">
                        {[l.telegram ? `@${l.telegram}` : null, l.city, `${l.books} кн.`]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div className="d muted" style={{ marginTop: 'var(--sp-2)' }}>
                Оставьте пустым — книга встанет на вашу полку.
              </div>
            </>
          )}
        </div>
      )}

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
          <div style={{ marginBottom: 'var(--sp-4)' }}>
            <TagPicker
              options={facets?.languageOptions ?? LANGS_FALLBACK}
              value={langs}
              onChange={setLangs}
              max={3}
              searchPlaceholder="Найти язык…"
            />
          </div>

          <div className="section-title">Жанры</div>
          <div style={{ marginBottom: 'var(--sp-5)' }}>
            {/* сверху — то, что чаще всего стоит у книг проекта, дальше весь
                справочник Notion; своего жанра здесь завести нельзя */}
            <TagPicker
              options={genreOptions}
              value={genres}
              onChange={setGenres}
              max={5}
              searchPlaceholder="Найти жанр…"
              emptyHint="Выберите хотя бы один жанр — по ним книгу ищут в каталоге."
            />
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
