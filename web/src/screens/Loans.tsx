import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Route } from '../App'
import type { Book, Loan } from '../types'
import { haptic, openTg, showAlert } from '../telegram'

const DAY = 86_400_000
const TERMS: { label: string; days: number | null }[] = [
  { label: '2 недели', days: 14 },
  { label: 'месяц', days: 30 },
  { label: 'без срока', days: null },
]

const daysOut = (iso: string) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / DAY))

/** «У кого моя книга сейчас»: список выданных книг и форма новой выдачи. */
export function Loans({ go }: { go: (r: Route) => void }) {
  const [given, setGiven] = useState<Loan[]>([])
  const [taken, setTaken] = useState<Loan[]>([])
  const [myBooks, setMyBooks] = useState<Book[]>([])
  const [loading, setLoading] = useState(true)

  const [title, setTitle] = useState('')
  const [bookId, setBookId] = useState<string | null>(null)
  const [holder, setHolder] = useState('')
  const [term, setTerm] = useState<number | null>(30)
  const [saving, setSaving] = useState(false)
  const [invite, setInvite] = useState<string | null>(null)

  const load = () =>
    api
      .loans()
      .then((r) => {
        setGiven(r.given)
        setTaken(r.taken)
      })
      .catch(() => {})
      .finally(() => setLoading(false))

  useEffect(() => {
    load()
    api.myBooks().then(setMyBooks).catch(() => {})
  }, [])

  async function lend() {
    setSaving(true)
    try {
      const res = await api.lend({
        title: title.trim(),
        holder: holder.trim(),
        bookId: bookId ?? undefined,
        days: term,
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

  async function markBack(id: string) {
    try {
      await api.loanReturn(id)
      haptic('success')
      await load()
    } catch (e: any) {
      showAlert(e.message)
    }
  }

  const suggestions = title.trim().length >= 2
    ? myBooks.filter((b) => b.title.toLowerCase().includes(title.trim().toLowerCase())).slice(0, 4)
    : []

  return (
    <>
      <h1>Мои книги на руках</h1>
      <div className="sub">Отметьте, кому отдали — напомню обоим, когда придёт время</div>

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

      <div className="section-title">Договорились до</div>
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

      {given.length > 0 && (
        <>
          <div className="section-title">Сейчас у читателей ({given.length})</div>
          {given.map((l) => {
            const overdue = l.dueAt && Date.parse(l.dueAt) < Date.now()
            return (
              <div key={l.id} className="row-card static">
                <div className="cover">
                  {l.book?.coverUrl ? (
                    <img src={l.book.coverUrl} alt="" loading="lazy" />
                  ) : (
                    <span>📕</span>
                  )}
                </div>
                <div className="grow">
                  <div className="t-sm">{l.title}</div>
                  <div className="market-meta">
                    <span className="tag">@{l.holderUsername ?? 'читатель'}</span>
                    <span className={`tag ${overdue ? 'sell' : ''}`}>
                      {daysOut(l.takenAt)} дн.
                    </span>
                    {overdue && <span className="tag sell">пора вернуть</span>}
                  </div>
                  <button className="link-row" onClick={() => markBack(l.id)}>
                    ✅ Книга вернулась
                  </button>
                </div>
              </div>
            )
          })}
        </>
      )}

      {taken.length > 0 && (
        <>
          <div className="section-title">Читаю сейчас ({taken.length})</div>
          {taken.map((l) => (
            <div key={l.id} className="row-card static">
              <div className="cover">
                <span>📗</span>
              </div>
              <div className="grow">
                <div className="t-sm">{l.title}</div>
                <div className="market-meta">
                  <span className="tag">{daysOut(l.takenAt)} дн. у меня</span>
                </div>
                <button className="link-row" onClick={() => markBack(l.id)}>
                  ✅ Вернул(а) книгу
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {!loading && given.length === 0 && taken.length === 0 && (
        <div className="foot">
          Пока пусто. Как отдадите книгу почитать — запишите здесь, чтобы не держать в голове.
        </div>
      )}
    </>
  )
}
