import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Route } from '../App'
import type { Book, Loan, LoanSummary, HistoryLoan, Person } from '../types'
import { haptic, openTg, showAlert, showConfirm, onAppShow } from '../telegram'
import { warsawDay } from '../dates'
import { MoodBoard } from './MoodBoard'
import { ShelfPicker } from './ShelfPicker'

const UNDO_ERRORS: Record<string, string> = {
  too_late: 'Отменить уже нельзя — прошло больше суток.',
  book_relent: 'Книга уже выдана другому человеку.',
  not_returned: 'Эта выдача снова активна.',
  forbidden: 'Это не ваша выдача.',
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })

const TERMS: { label: string; days: number | null }[] = [
  { label: '2 недели', days: 14 },
  { label: 'месяц', days: 30 },
  { label: 'без срока', days: null },
]

/**
 * Подсказка книг с полки (B1, ТЗ 5.08.2026).
 *
 * Раньше список раскрывался сразу и целиком, со строкой «и ещё 85»: под полем
 * висел вечно открытый автокомплит, из-за которого формы почти не было видно.
 * Теперь список — ответ на ввод: два символа и не больше шести совпадений,
 * а вся полка живёт в отдельной шторке, где для выбора есть обложки и поиск.
 */
const SUGGEST_LIMIT = 6
const SUGGEST_MIN_CHARS = 2

/**
 * Сравнение «по-человечески»: регистр, ё/е и знаки препинания не должны мешать
 * найти свою же книгу («Мастер и Маргарита» ↔ «мастер и маргарита»).
 */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Ищем и по названию, и по автору: половину книг помнят именно по автору. */
export function bookMatches(b: { title: string; author: string | null }, needle: string): boolean {
  return norm(`${b.title} ${b.author ?? ''}`).includes(needle)
}

/**
 * Насколько совпадение похоже на то, что человек имел в виду: начало названия
 * важнее середины, название важнее автора. Без этого шесть подсказок могли
 * оказаться случайными — совпадение по автору стояло бы выше точного названия.
 */
export function matchRank(b: { title: string; author: string | null }, needle: string): number {
  const title = norm(b.title)
  if (title.startsWith(needle)) return 0
  if (title.includes(needle)) return 1
  if (norm(b.author ?? '').startsWith(needle)) return 2
  return 3
}

/** «У кого моя книга сейчас»: список выданных книг и форма новой выдачи. */
export function Loans({ go }: { go: (r: Route) => void }) {
  const [given, setGiven] = useState<Loan[]>([])
  const [taken, setTaken] = useState<Loan[]>([])
  const [history, setHistory] = useState<HistoryLoan[]>([])
  const [tab, setTab] = useState<'given' | 'taken' | 'history'>('given')
  const [summary, setSummary] = useState<LoanSummary | null>(null)
  const [myBooks, setMyBooks] = useState<Book[]>([])
  const [loading, setLoading] = useState(true)

  const [title, setTitle] = useState('')
  const [bookId, setBookId] = useState<string | null>(null)
  const [holder, setHolder] = useState('')
  const [term, setTerm] = useState<number | null>(30)
  // варшавский календарный день: ночью «сегодня» не уезжает на вчера (UTC)
  const [takenAt, setTakenAt] = useState(() => warsawDay())
  const [saving, setSaving] = useState(false)
  const [invite, setInvite] = useState<string | null>(null)
  // подсказка людей: ники бывают длинные, набирать их вручную с телефона больно
  const [people, setPeople] = useState<Person[]>([])
  const [holderPicked, setHolderPicked] = useState(false)
  /** открыт полный список полки: вспоминать название по памяти не нужно */
  const [picker, setPicker] = useState(false)

  const load = () =>
    api
      .loans()
      .then((r) => {
        setGiven(r.given)
        setTaken(r.taken)
        setHistory(r.history)
        setSummary(r.summary)
      })
      .catch(() => {})
      .finally(() => setLoading(false))

  useEffect(() => {
    load()
    api.myBooks().then(setMyBooks).catch(() => {})
    return onAppShow(load)
  }, [])

  /**
   * Подсказки к нику. Ждём паузу в наборе, чтобы не дёргать сервер на каждую
   * букву, и молчим, когда человека уже выбрали из списка.
   */
  useEffect(() => {
    const needle = holder.trim().replace(/^@/, '')
    if (holderPicked || needle.length < 1) {
      setPeople([])
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      api
        .people(needle)
        .then((r) => alive && setPeople(r.people))
        .catch(() => alive && setPeople([]))
    }, 250)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [holder, holderPicked])

  async function lend() {
    setSaving(true)
    try {
      const res = await api.lend({
        title: title.trim(),
        holder: holder.trim(),
        bookId: bookId ?? undefined,
        days: term,
        takenAt,
      })
      haptic('success')
      setInvite(res.inviteUrl)
      setTitle('')
      setHolder('')
      setBookId(null)
      await load()
    } catch (e: any) {
      const messages: Record<string, string> = {
        bad_holder: 'Ник не похож на телеграм — напишите @ник или ссылку t.me/ник.',
        empty_title: 'Впишите название книги.',
        // раньше эти два кода показывались человеку как есть, латиницей
        book_busy: 'Эта книга уже на руках — сначала отметьте возврат.',
        not_your_book: 'Эта книга не с вашей полки.',
        unauthorized: 'Откройте приложение через бота',
      }
      showAlert(messages[e.message] ?? e.message)
    } finally {
      setSaving(false)
    }
  }

  async function markBack(l: { id: string; title: string }) {
    if (!(await showConfirm(`Точно отметить «${l.title}» как возвращённую?`))) return
    try {
      await api.loanReturn(l.id)
      haptic('success')
      await load()
    } catch (e: any) {
      showAlert(e.message)
    }
  }

  async function undo(l: HistoryLoan) {
    try {
      await api.loanReopen(l.id)
      haptic('success')
      await load()
    } catch (e: any) {
      showAlert(UNDO_ERRORS[e.message] ?? e.message)
    }
  }

  // Подсказка с полки: отвечает на ввод, а не висит открытой (B1).
  // Занятые книги в подсказку не идут — выдать их нельзя.
  const needle = norm(title)
  const searching = needle.length >= SUGGEST_MIN_CHARS
  const onShelf = myBooks.filter((b) => b.status !== 'busy')
  const matched = searching ? onShelf.filter((b) => bookMatches(b, needle)) : []
  const suggestions = [...matched]
    .sort((a, b) => matchRank(a, needle) - matchRank(b, needle))
    .slice(0, SUGGEST_LIMIT)
  // занятые не предлагаем (выдать их нельзя), но если человек ищет именно такую —
  // честно говорим почему, иначе «моей книги нет в списке» выглядит поломкой
  const busyMatch = searching
    ? myBooks.filter((b) => b.status === 'busy' && bookMatches(b, needle)).slice(0, 2)
    : []

  return (
    <>
      {/* «На руках» без уточнения читалось двусмысленно: у кого именно на руках
          — у меня или у читателя? Экран теперь называется «Выдачи», а вкладки
          говорят прямо (B2, ТЗ 5.08.2026). Пункт меню остался прежним. */}
      <h1>Выдачи</h1>
      <div className="sub">Отметьте, кому отдали — напомню обоим, когда придёт время</div>

      <MoodBoard summary={summary} />

      <div className="field-group">
        <input
          className="input"
          placeholder="Название книги *"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
            setBookId(null)
          }}
        />
        {/* пока не начали вводить — подсказываем, что делать, а не вываливаем
            полку целиком (B1, ТЗ 5.08.2026) */}
        {!searching && !bookId && myBooks.length > 0 && (
          <div className="muted">Начните вводить название или выберите книгу из своей полки.</div>
        )}
        {searching && suggestions.length > 0 && !bookId && (
          <div className="note" style={{ marginBottom: 0 }}>
            С вашей полки:
            {suggestions.map((b) => (
              <button
                key={b.id}
                className="link-row"
                onClick={() => {
                  haptic('light')
                  setTitle(b.title)
                  setBookId(b.id) // выдаём КОНКРЕТНУЮ книгу, а не строку с названием
                }}
              >
                {b.title}
                {b.author ? ` — ${b.author}` : ''}
              </button>
            ))}
          </div>
        )}
        {/* весь список полки: раньше сверх пяти подсказок оставалось только
            «впишите название точнее», то есть вспоминать книгу по памяти
            (просьба user 29.07.2026). Кнопка на месте всегда — это и есть
            замена вечно открытому списку */}
        {myBooks.length > 0 && (
          <button
            className="link-row"
            onClick={() => {
              haptic()
              setPicker(true)
            }}
          >
            📚 Выбрать из своей полки ({myBooks.length})
          </button>
        )}
        {busyMatch.length > 0 && !bookId && (
          <div className="note" style={{ marginBottom: 0 }}>
            {busyMatch.map((b) => (
              <div key={b.id} className="muted">
                «{b.title}» уже на руках — сначала отметьте возврат
              </div>
            ))}
          </div>
        )}
        <input
          className="input"
          placeholder="@ник читателя *"
          autoCapitalize="off"
          autoCorrect="off"
          value={holder}
          onChange={(e) => {
            setHolder(e.target.value)
            setHolderPicked(false)
          }}
        />
        {people.length > 0 && (
          <div className="note" style={{ marginBottom: 0 }}>
            Кому отдали:
            {people.map((p) => (
              <button
                key={p.telegram}
                className="link-row"
                onClick={() => {
                  haptic('light')
                  setHolder(`@${p.telegram}`)
                  setHolderPicked(true)
                  setPeople([])
                }}
              >
                {p.name === `@${p.telegram}` ? p.name : `${p.name} · @${p.telegram}`}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="section-title">Когда отдали</div>
      <div className="field-group" style={{ marginBottom: 'var(--sp-3)' }}>
        <input
          className="input"
          type="date"
          max={warsawDay()}
          value={takenAt}
          onChange={(e) => setTakenAt(e.target.value)}
        />
      </div>
      <div className="sub" style={{ marginBottom: 'var(--sp-4)' }}>
        Отдали давно? Поставьте настоящую дату — дни на дашборде посчитаются точно.
      </div>

      <div className="section-title">Договорились на</div>
      <div className="chips" style={{ marginBottom: 'var(--sp-4)' }}>
        {TERMS.map((t) => (
          <button
            key={t.label}
            className={`chip sm ${term === t.days ? 'active' : ''}`}
            onClick={() => setTerm(t.days)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <button
        className="btn"
        disabled={saving || title.trim().length < 2 || holder.trim().length < 2}
        onClick={lend}
      >
        {saving ? 'Записываю…' : 'Записать выдачу'}
      </button>

      {invite && (
        <div className="note" style={{ marginTop: 'var(--sp-4)' }}>
          Готово. Если читатель ещё не знаком с ботом — перешлите ему ссылку, тогда
          он будет получать напоминания и сможет отметить возврат сам.
          <button className="link-row" onClick={() => openTg(invite)}>
            Открыть ссылку-приглашение
          </button>
        </div>
      )}

      {loading && <div className="muted" style={{ marginTop: 'var(--sp-5)' }}>Загружаю…</div>}

      {!loading && (given.length > 0 || taken.length > 0 || history.length > 0) && (
        <>
          <div className="chips" role="tablist" style={{ margin: 'var(--sp-5) 0 var(--sp-4)' }}>
            <button
              role="tab"
              aria-selected={tab === 'given'}
              aria-label="Мои книги у читателей"
              className={`chip ${tab === 'given' ? 'active' : ''}`}
              onClick={() => setTab('given')}
            >
              У читателей{given.length ? ` · ${given.length}` : ''}
            </button>
            <button
              role="tab"
              aria-selected={tab === 'taken'}
              aria-label="Чужие книги у меня"
              className={`chip ${tab === 'taken' ? 'active' : ''}`}
              onClick={() => setTab('taken')}
            >
              Я читаю{taken.length ? ` · ${taken.length}` : ''}
            </button>
            <button
              role="tab"
              aria-selected={tab === 'history'}
              aria-label="История выдач"
              className={`chip ${tab === 'history' ? 'active' : ''}`}
              onClick={() => setTab('history')}
            >
              История
            </button>
          </div>

          {tab === 'given' &&
            (given.length ? (
              given.map((l) => (
                <div key={l.id} className={`loan-card level-${l.mood.level}`}>
                  <div className="loan-top">
                    <div className="loan-cover">
                      {l.book?.coverUrl ? (
                        <img src={l.book.coverUrl} alt="" loading="lazy" />
                      ) : (
                        <span>📕</span>
                      )}
                      <span className="loan-face">{l.mood.emoji}</span>
                    </div>
                    <div className="grow">
                      <div className="loan-title">{l.title}</div>
                      <div className="loan-who">
                        у @{l.holderUsername ?? 'читателя'} · с {fmtDate(l.takenAt)}
                      </div>
                      <div className="market-meta">
                        <span className={`tag mood-${l.mood.level}`}>{l.mood.days} дн.</span>
                        <span className={`tag mood-${l.mood.level}`}>{l.mood.label}</span>
                        {l.mood.overdueDays > 0 && (
                          <span className="tag sell">просрочка {l.mood.overdueDays} дн.</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <button className="btn ghost sm" onClick={() => markBack(l)}>
                    ✅ Книга вернулась
                  </button>
                </div>
              ))
            ) : (
              <div className="foot">Сейчас у читателей ничего нет.</div>
            ))}

          {tab === 'taken' &&
            (taken.length ? (
              taken.map((l) => (
                <div key={l.id} className={`loan-card level-${l.mood.level}`}>
                  <div className="loan-top">
                    <div className="loan-cover">
                      <span>📗</span>
                    </div>
                    <div className="grow">
                      <div className="loan-title">{l.title}</div>
                      <div className="loan-who">взял(а) {fmtDate(l.takenAt)}</div>
                      <div className="market-meta">
                        <span className={`tag mood-${l.mood.level}`}>{l.mood.days} дн. у меня</span>
                        {l.mood.level >= 2 && <span className="tag sell">пора вернуть</span>}
                      </div>
                    </div>
                  </div>
                  {/* читатель НЕ закрывает выдачу: возврат подтверждает владелец,
                      когда получит книгу назад (политика 5.08.2026, A1). Здесь
                      только информация, действия нет */}
                  <div className="loan-info">
                    Когда вернёте книгу, возврат отметит владелец.
                  </div>
                </div>
              ))
            ) : (
              <div className="foot">Вы сейчас ничего не читаете из библиотеки.</div>
            ))}

          {tab === 'history' &&
            (history.length ? (
              history.map((l) => (
                <div key={l.id} className="loan-card level-0">
                  <div className="loan-top">
                    <div className="loan-cover">
                      {l.book?.coverUrl ? (
                        <img src={l.book.coverUrl} alt="" loading="lazy" />
                      ) : (
                        <span>📚</span>
                      )}
                    </div>
                    <div className="grow">
                      <div className="loan-title">{l.title}</div>
                      <div className="loan-who">
                        {l.role === 'given' ? `отдавали @${l.holderUsername ?? 'читателю'}` : 'вы читали'}
                        {l.returnedAt ? ` · вернулась ${fmtDate(l.returnedAt)}` : ''}
                      </div>
                    </div>
                  </div>
                  {l.canUndo && (
                    <button className="btn ghost sm" onClick={() => undo(l)}>
                      ↩️ Отменить возврат
                    </button>
                  )}
                </div>
              ))
            ) : (
              <div className="foot">Закрытых выдач пока нет.</div>
            ))}
        </>
      )}

      {picker && (
        <ShelfPicker
          books={myBooks}
          onClose={() => setPicker(false)}
          onPick={(b) => {
            setTitle(b.title)
            setBookId(b.id)
            setPicker(false)
          }}
        />
      )}

      {!loading && given.length === 0 && taken.length === 0 && history.length === 0 && (
        <div className="empty">
          <img className="illus sm" src="/il/handoff.jpg" alt="" loading="lazy" />
          Пока пусто. Как отдадите книгу почитать — запишите здесь, чтобы не держать в голове.
        </div>
      )}
    </>
  )
}
