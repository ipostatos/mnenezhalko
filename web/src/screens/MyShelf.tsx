import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Route } from '../App'
import type { Facets, ShelfBook, ShelfState } from '../types'
import { haptic, showAlert, showConfirm, onAppShow } from '../telegram'
import { useSeqGuard } from '../useSeqGuard'
import { Icon } from './Icon'
import { plural } from '../plural'
import { TagPicker } from './TagPicker'

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
  // выбранный счётчик работает фильтром: плитки и раньше выглядели нажимаемыми,
  // но были обычными блоками — нажатие ничего не делало
  const [only, setOnly] = useState<ShelfState | null>(null)
  // «показать только книги без жанра»: после добавления пачкой жанры проставились
  // не везде, и найти такие книги можно было только перебором вручную
  const [noGenre, setNoGenre] = useState(false)
  const guard = useSeqGuard()

  /** Город книги, если он ОТЛИЧАЕТСЯ от вашего: одинаковый — лишний шум. */
  const otherCity = (b: ShelfBook) => {
    if (!b.city || b.city === city) return null
    return b.district ? `${b.city} / ${b.district}` : b.city
  }

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
  const missingGenre = (b: ShelfBook) =>
    b.kind === 'book' && !b.genres.length && b.state !== 'deleted'
  const grouped = ORDER.filter((s) => !only || s === only)
    .map((s) => ({
      state: s,
      items: books.filter((b) => b.state === s && matches(b) && (!noGenre || missingGenre(b))),
    }))
    .filter((g) => g.items.length)

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

      {/* город стоит здесь один раз — сразу видно, верно ли он выбран. В каждой
          книге он повторялся без пользы (просьба user 29.07.2026) */}
      <button
        className="shelf-city"
        onClick={() => {
          haptic()
          go({ name: 'cities' })
        }}
      >
        <Icon name="pin" />
        <span className="grow">
          {city ? (
            <>
              Ваш город: <b>{city}</b>
            </>
          ) : (
            'Город не выбран — книги встанут на полку без города'
          )}
        </span>
        <span className="chev">›</span>
      </button>

      {books.length > 0 && (
        <div className="stat-tiles">
          {(['active', 'onloan', 'pending'] as ShelfState[]).map((s) => (
            <button
              key={s}
              className={`s${only === s ? ' on' : ''}`}
              aria-pressed={only === s}
              aria-label={`${STATE[s].label}: ${count(s)}${only === s ? ', фильтр включён' : ''}`}
              onClick={() => {
                haptic()
                // повторное нажатие снимает фильтр — иначе из него не выйти
                setOnly((cur) => (cur === s ? null : s))
              }}
            >
              <div className="n">{count(s)}</div>
              <div className="c">{STATE[s].label.toLowerCase()}</div>
            </button>
          ))}
        </div>
      )}

      {/* книги без жанра не находятся по жанру в каталоге; после добавления
          пачкой их обычно несколько, а заметить их можно было только вручную */}
      {books.some(missingGenre) && (
        <div className="note">
          У {books.filter(missingGenre).length}{' '}
          {plural(books.filter(missingGenre).length, ['книги', 'книг', 'книг'])} не указан жанр — по
          жанру их не найдут в каталоге.
          <button
            className="link-row"
            onClick={() => {
              haptic()
              setNoGenre((v) => !v)
            }}
          >
            {noGenre ? 'Показать все книги' : 'Показать эти книги'}
          </button>
        </div>
      )}

      {/* лента значков с полки убрана (просьба user 4.08.2026, вслед за плашкой
          на главной). Экран `badges` и ручка /api/my-badges на месте —
          вернуть можно строкой {books.length > 0 && <Badges go={go} />} */}

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
        <div className="empty">
          {only
            ? `Книг в состоянии «${STATE[only].label.toLowerCase()}» нет.`
            : 'Ничего не нашлось на полке. Попробуйте другое слово.'}
          {only && (
            <button className="link-btn" onClick={() => setOnly(null)} style={{ display: 'block', margin: '8px auto 0' }}>
              Показать все книги
            </button>
          )}
        </div>
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
                  {/* город из карточки убран: он один и тот же у всей полки и
                      стоит строкой наверху экрана. Здесь показываем его, только
                      если у книги он ДРУГОЙ — вот это как раз важно заметить */}
                  {(b.author || otherCity(b)) && (
                    <div className="shelf-meta">
                      {[b.author, otherCity(b)].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  {/* состояние читается по цветной полосе слева и заголовку группы —
                      бейдж на самой карточке был бы третьим повтором того же */}
                  <div className="market-meta">
                    {b.kind === 'game' && <span className="tag">настолка</span>}
                    {/* жанры на виду: после добавления пачкой они проставились не
                        везде, и раньше это было видно, только зайдя в каждую книгу */}
                    {b.genres.map((g) => (
                      <span key={g} className="tag">
                        {g}
                      </span>
                    ))}
                    {b.kind === 'book' && !b.genres.length && b.state !== 'deleted' && (
                      <button
                        className="tag warn-tag"
                        onClick={() => {
                          haptic()
                          setEditing(b.id)
                        }}
                      >
                        жанр не указан — добавить
                      </button>
                    )}
                  </div>
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
  const [genres, setGenres] = useState<string[]>(book.genres)
  const [langs, setLangs] = useState<string[]>(book.languages)
  const [place, setPlace] = useState(book.city ?? city ?? '')
  const [facets, setFacets] = useState<Facets | null>(null)
  const [saving, setSaving] = useState(false)

  // справочник жанров и языков проекта: правим выбором из списка, не текстом
  useEffect(() => {
    api.facets().then(setFacets).catch(() => {})
  }, [])

  async function save() {
    if (title.trim().length < 2) return showAlert('Название слишком короткое.')
    setSaving(true)
    try {
      await api.editBook(book.id, {
        title: title.trim(),
        author: author.trim() || null,
        genres,
        languages: langs,
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
      {/* жанр и язык выбираются из справочника проекта: свободный ввод разводил
          в общей таблице синонимы и опечатки, а админам их потом разбирать */}
      <div className="field">
        <label>Жанры</label>
        <TagPicker
          options={facets?.genreOptions ?? []}
          value={genres}
          onChange={setGenres}
          max={5}
          searchPlaceholder="Найти жанр…"
          emptyHint="Жанр не указан — по нему книгу ищут в каталоге, выберите хотя бы один."
        />
      </div>
      <div className="field">
        <label>Языки</label>
        <TagPicker
          options={facets?.languageOptions ?? []}
          value={langs}
          onChange={setLangs}
          max={3}
          searchPlaceholder="Найти язык…"
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
