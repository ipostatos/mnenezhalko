import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Route } from '../App'
import type { Book, Loan, LoanSummary, HistoryLoan } from '../types'
import { haptic, openTg, showAlert, showConfirm, onAppShow } from '../telegram'
import { warsawDay } from '../dates'
import { MoodBoard } from './MoodBoard'

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

  const suggestions = title.trim().length >= 2
    ? myBooks.filter((b) => b.title.toLowerCase().includes(title.trim().toLowerCase())).slice(0, 4)
    : []

  return (
    <>
      <h1>Мои книги на руках</h1>
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
        {suggestions.length > 0 && !bookId && (
          <div className="note" style={{ marginBottom: 0 }}>
            С вашей полки:
            {suggestions.map((b) => (
              <button
                key={b.id}
                className="link-row"
                onClick={() => {
                  setTitle(b.title)
                  setBookId(b.id)
                }}
              >
                {b.title}
                {b.author ? ` — ${b.author}` : ''}
              </button>
            ))}
          </div>
        )}
        <input
          className="input"
          placeholder="@ник читателя *"
          autoCapitalize="off"
          autoCorrect="off"
          value={holder}
          onChange={(e) => setHolder(e.target.value)}
        />
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
          <div className="chips" style={{ margin: 'var(--sp-5) 0 var(--sp-4)' }}>
            <button className={`chip ${tab === 'given' ? 'active' : ''}`} onClick={() => setTab('given')}>
              На руках{given.length ? ` · ${given.length}` : ''}
            </button>
            <button className={`chip ${tab === 'taken' ? 'active' : ''}`} onClick={() => setTab('taken')}>
              Я читаю{taken.length ? ` · ${taken.length}` : ''}
            </button>
            <button
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
                  <button className="btn ghost sm" onClick={() => markBack(l)}>
                    ✅ Вернул(а) книгу
                  </button>
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

      {!loading && given.length === 0 && taken.length === 0 && history.length === 0 && (
        <div className="empty">
          <img className="illus sm" src="/il/handoff.jpg" alt="" loading="lazy" />
          Пока пусто. Как отдадите книгу почитать — запишите здесь, чтобы не держать в голове.
        </div>
      )}
    </>
  )
}
