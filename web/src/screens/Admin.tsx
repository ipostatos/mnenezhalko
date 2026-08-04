/**
 * Разбор для админов — то же, что команда `/moderation` в боте, но экраном.
 *
 * Зачем экран, если в боте всё есть: в переписке карточка книги теряется среди
 * сообщений, обложку не разглядеть, а список ограничений читается как «990010:
 * оценки и отзывы». Здесь видно, ЧТО решаем: обложка, чья книга, город, жанры,
 * сколько ждёт.
 *
 * Спрятанные кнопки защитой не считаются: те же решения принимает бот и
 * принимают ручки напрямую, поэтому права проверяет сервер (see moderation.ts).
 * Экран прячется от неадминов только чтобы не путать людей.
 *
 * Причина решения — поле в самой карточке, а не всплывающий prompt: причину
 * читает человек, которому отказали, и набирать её вслепую в модальном окне
 * Telegram неудобно.
 */
import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ModerationQueue, PendingBook, QueueReview } from '../types'
import { haptic, showAlert, showConfirm, onAppShow } from '../telegram'
import { useSeqGuard } from '../useSeqGuard'
import { Icon } from './Icon'
import { plural } from '../plural'

type Tab = 'books' | 'reviews' | 'people' | 'log'

/** Области ограничений — те же значения, что `SCOPES` на сервере. */
const SCOPES: { key: string; title: string }[] = [
  { key: 'add_books', title: 'добавление книг' },
  { key: 'reviews', title: 'оценки и отзывы' },
  { key: 'reports', title: 'жалобы на отзывы' },
  { key: 'waitlist', title: 'очереди на книги' },
  { key: 'market', title: 'барахолка' },
  { key: 'ai', title: 'подбор книги' },
  { key: 'all', title: 'все действия' },
]

const scopeTitle = (key: string) => SCOPES.find((s) => s.key === key)?.title ?? key

/**
 * «снято» одинаково называется у объявления и у встречи, поэтому подпись
 * в журнале собирается вместе с типом: иначе строка читается как «remove».
 */
const REMOVED_TITLES: Record<string, string> = {
  market: 'снято объявление',
  event: 'убрана встреча',
}

/** «одобрил», «скрыл» — журнал должен читаться, а не расшифровываться. */
const ACTION_TITLES: Record<string, string> = {
  approve: 'одобрена книга',
  reject: 'отклонена книга',
  hide: 'скрыт отзыв',
  restore: 'возвращён отзыв',
  delete: 'удалён отзыв',
  dismiss: 'отклонены жалобы',
  restrict: 'ограничение',
  unrestrict: 'ограничение снято',
  ban: 'блокировка',
  unban: 'блокировка снята',
}

const dateFmt = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Warsaw',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

const when = (iso: string) => dateFmt.format(new Date(iso))

/** Срок ограничения — только дата: часы и минуты у «до 29 августа» лишние. */
const dayFmt = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Warsaw',
  day: 'numeric',
  month: 'long',
})
const untilDay = (iso: string) => dayFmt.format(new Date(iso))

/**
 * `workKey` — служебный ключ произведения («мастер и маргарита|булгаков»):
 * приведённое название и автор через палку. В таком виде его показывать нельзя,
 * поэтому разбираем обратно; регистр восстанавливаем только у первой буквы —
 * настоящего написания в ключе уже нет.
 */
function workTitle(key: string): string {
  const up = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
  const [title, author] = key.split('|')
  return [up(title ?? key), up(author ?? '')].filter(Boolean).join(' · ')
}

/** Сколько ждёт решения: «сегодня», «2 дня» — по этому и выбирают, что первым. */
function waiting(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return 'сегодня'
  return `${days} ${plural(days, ['день', 'дня', 'дней'])}`
}

export function Admin() {
  const [q, setQ] = useState<ModerationQueue | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('books')
  const [busy, setBusy] = useState<string | null>(null)
  const guard = useSeqGuard()

  const load = () => {
    const id = guard.next()
    setError('')
    return api
      .moderationQueue()
      .then((r) => {
        if (!guard.isCurrent(id)) return
        setQ(r)
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

  /** Одна обёртка на все решения: занятость, ошибка человеку, перезагрузка. */
  async function act(key: string, run: () => Promise<unknown>, ok?: string) {
    setBusy(key)
    try {
      await run()
      haptic('success')
      if (ok) showAlert(ok)
      await load()
    } catch (e: any) {
      showAlert(MESSAGES[e.message] ?? e.message)
    } finally {
      setBusy(null)
    }
  }

  if (error && !q) {
    return (
      <div className="empty">
        <div className="error-banner">{error === 'forbidden' ? 'Этот раздел только для админов.' : error}</div>
        <button className="btn" onClick={load}>
          Попробовать ещё раз
        </button>
      </div>
    )
  }
  if (!q) return <div className="spinner">Загружаю очередь…</div>

  const TABS: { key: Tab; title: string; count: number }[] = [
    { key: 'books', title: 'Книги', count: q.pendingBooksCount },
    { key: 'reviews', title: 'Отзывы', count: q.reviews.length },
    { key: 'people', title: 'Люди', count: q.restrictions.length + q.banned.length },
    { key: 'log', title: 'Журнал', count: q.recent.length },
  ]

  return (
    <>
      <h1>Разбор</h1>
      <div className="sub">Что ждёт решения: книги, отзывы и участники</div>

      {/* письма о решениях, которые не дошли: человек не знает, что ему ответили,
          и будет ждать. Это важнее любой строки в очереди, поэтому наверху */}
      {q.stuckNotices > 0 && (
        <div className="warn-banner">
          {q.stuckNotices} {plural(q.stuckNotices, ['письмо', 'письма', 'писем'])} о решениях не
          дошло до людей — скорее всего, они не начинали диалог с ботом. Они не знают, что им
          ответили.
        </div>
      )}

      <div className="segmented admin-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? 'active' : ''}
            aria-pressed={tab === t.key}
            onClick={() => {
              haptic()
              setTab(t.key)
            }}
          >
            {t.title}
            {t.count > 0 && <span className="tab-count">{t.count}</span>}
          </button>
        ))}
      </div>

      {tab === 'books' &&
        (q.pendingBooks.length ? (
          q.pendingBooks.map((b) => (
            <BookCard
              key={b.id}
              book={b}
              busy={busy === `book:${b.id}`}
              onApprove={() =>
                act(`book:${b.id}`, () => api.decideBook(b.id, 'approve'), 'Книга в каталоге.')
              }
              onReject={(reason) =>
                act(`book:${b.id}`, () => api.decideBook(b.id, 'reject', reason))
              }
            />
          ))
        ) : (
          <div className="empty">Книг на проверке нет — очередь пуста.</div>
        ))}

      {tab === 'reviews' &&
        (q.reviews.length ? (
          q.reviews.map((r) => (
            <ReviewCard
              key={r.id}
              review={r}
              busy={busy === `review:${r.id}`}
              onDecide={(decision, reason) =>
                act(`review:${r.id}`, () => api.decideReview(r.id, decision, reason))
              }
              onRestrict={(scope, days, reason) =>
                act(`review:${r.id}`, () => api.restrictUser(r.authorTg, scope, reason, days))
              }
            />
          ))
        ) : (
          <div className="empty">Жалоб и скрытых отзывов нет.</div>
        ))}

      {tab === 'people' && (
        <>
          <div className="section-title">Действующие ограничения · {q.restrictions.length}</div>
          {!q.restrictions.length && <div className="empty">Никого не ограничивали.</div>}
          {q.restrictions.map((r) => (
            <div key={r.id} className="shelf-card" style={{ ['--tone' as any]: '#e0a44a' }}>
              <div>
                {/* ник показываем с собачкой: без неё «noname» читается как имя */}
                <div className="shelf-title">
                  {r.name ?? (r.username ? `@${r.username}` : `id ${r.userTg}`)}
                </div>
                <div className="shelf-meta">
                  {scopeTitle(r.scope)} ·{' '}
                  {r.expiresAt ? `до ${untilDay(r.expiresAt)}` : 'бессрочно'}
                </div>
                <div className="shelf-note">Причина: {r.reason}</div>
              </div>
              <ReasonAction
                label="Снять ограничение"
                icon="refresh"
                busy={busy === `restr:${r.id}`}
                placeholder="Почему снимаем"
                onSubmit={(reason) =>
                  act(
                    `restr:${r.id}`,
                    () => api.unrestrictUser(r.userTg, r.scope, reason),
                    'Ограничение снято.',
                  )
                }
              />
            </div>
          ))}

          <div className="section-title">Заблокированные · {q.banned.length}</div>
          {!q.banned.length && <div className="empty">Заблокированных нет.</div>}
          {q.banned.map((b) => (
            <div key={b.tgId} className="shelf-card" style={{ ['--tone' as any]: '#d9584b' }}>
              <div>
                <div className="shelf-title">
                  {b.firstName ?? (b.username ? `@${b.username}` : `id ${b.tgId}`)}
                </div>
                <div className="shelf-meta">
                  {b.bannedAt ? `заблокирован ${when(b.bannedAt)}` : 'заблокирован'}
                </div>
                {b.reason && <div className="shelf-note">Причина: {b.reason}</div>}
              </div>
              <ReasonAction
                label="Разблокировать"
                icon="refresh"
                busy={busy === `ban:${b.tgId}`}
                placeholder="Почему возвращаем доступ"
                onSubmit={(reason) =>
                  act(`ban:${b.tgId}`, () => api.unbanUser(b.tgId, reason), 'Доступ возвращён.')
                }
              />
            </div>
          ))}
        </>
      )}

      {tab === 'log' && (
        <>
          <div className="section-title">Последние решения</div>
          {!q.recent.length && <div className="empty">Решений пока не было.</div>}
          {q.recent.map((a) => (
            <div key={a.id} className="log-row">
              <div className="log-when">{when(a.at)}</div>
              <div className="grow">
                <b>
                  {a.action === 'remove'
                    ? (REMOVED_TITLES[a.targetType] ?? 'снято')
                    : (ACTION_TITLES[a.action] ?? a.action)}
                </b>
                {a.targetName ? ` · ${a.targetName}` : ''}
                <div className="shelf-note">{a.reason}</div>
              </div>
            </div>
          ))}
          {/* журнал неизменяемый: пересмотр решения это НОВАЯ строка, а не правка
              старой — иначе по нему нельзя восстановить, что происходило */}
          <div className="note">
            Журнал не редактируется: изменение решения добавляет новую запись.
          </div>
        </>
      )}
    </>
  )
}

/** Понятные человеку тексты вместо кодов ошибок сервера. */
const MESSAGES: Record<string, string> = {
  no_reason: 'Без причины нельзя: её увидит человек, которому отказали.',
  in_progress: 'Эту книгу прямо сейчас одобряет другой админ.',
  rejected: 'Книга уже отклонена — её можно только отправить заново с полки.',
  deleted: 'Книга удалена владельцем.',
  not_found: 'Книга не найдена — возможно, её уже разобрали.',
  not_found_or_busy: 'Книга не найдена или её разбирает другой админ.',
  notion_failed: 'Не удалось записать книгу в общую таблицу. Можно повторить позже.',
  already_hidden: 'Отзыв уже скрыт.',
  already_visible: 'Отзыв уже виден.',
  already_restricted: 'Такое ограничение уже стоит.',
  forbidden: 'Этот раздел только для админов.',
  self: 'Себя ограничить нельзя.',
  admin: 'Админа ограничить нельзя.',
}

/** Карточка книги на проверке: видно, ЧТО решаем. */
function BookCard({
  book,
  busy,
  onApprove,
  onReject,
}: {
  book: PendingBook
  busy: boolean
  onApprove: () => void
  onReject: (reason: string) => void
}) {
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')

  return (
    <div className="shelf-card" style={{ ['--tone' as any]: '#6d8fb5' }}>
      <div className="shelf-top">
        <div className="cover">
          {book.coverUrl ? (
            <img src={book.coverUrl} alt="" loading="lazy" />
          ) : (
            book.title.slice(0, 1).toUpperCase()
          )}
        </div>
        <div className="grow">
          <div className="shelf-title">{book.title}</div>
          <div className="shelf-meta">
            {[book.author, book.ownerName, book.city].filter(Boolean).join(' · ')}
          </div>
          <div className="market-meta">
            {book.kind === 'game' && <span className="tag">настолка</span>}
            {book.genres.map((g) => (
              <span key={g} className="tag">
                {g}
              </span>
            ))}
            {book.languages.map((l) => (
              <span key={l} className="chip lang sm">
                {l}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="shelf-note">
        Ждёт: {waiting(book.submittedAt)} · добавлена через {book.source === 'bot' ? 'бота' : book.source}
      </div>

      {!rejecting ? (
        <div className="shelf-actions">
          <button className="btn sm" disabled={busy} onClick={onApprove}>
            <Icon name="check" /> Одобрить
          </button>
          <button
            className="btn sm ghost"
            disabled={busy}
            onClick={() => {
              haptic()
              setRejecting(true)
            }}
          >
            <Icon name="cross" /> Отклонить
          </button>
        </div>
      ) : (
        <div className="reason-form">
          {/* причину увидит человек: «не подходит» ему ничего не объясняет */}
          <input
            className="input"
            autoFocus
            placeholder="Причина отказа — её увидит человек"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="shelf-actions">
            <button
              className="btn sm"
              disabled={busy || !reason.trim()}
              onClick={() => onReject(reason.trim())}
            >
              Отправить отказ
            </button>
            <button
              className="btn sm ghost narrow"
              disabled={busy}
              onClick={() => {
                setRejecting(false)
                setReason('')
              }}
            >
              Отмена
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Карточка отзыва: текст, сколько УНИКАЛЬНЫХ жалоб, прошлые решения. */
function ReviewCard({
  review,
  busy,
  onDecide,
  onRestrict,
}: {
  review: QueueReview
  busy: boolean
  onDecide: (decision: 'hide' | 'restore' | 'delete' | 'dismiss', reason?: string) => void
  onRestrict: (scope: string, days: number | null, reason: string) => void
}) {
  const [restricting, setRestricting] = useState(false)
  const [scope, setScope] = useState('reviews')
  const [days, setDays] = useState('30')
  const hidden = review.status === 'hidden'

  return (
    <div className="shelf-card" style={{ ['--tone' as any]: hidden ? '#8f8578' : '#d9584b' }}>
      <div>
        <div className="shelf-title">{workTitle(review.workKey)}</div>
        <div className="shelf-meta">
          {'★'.repeat(review.rating)}
          {'☆'.repeat(5 - review.rating)} · {review.authorName ?? 'без имени'}
        </div>
        {review.text && <div className="review-quote">{review.text}</div>}
        <div className="shelf-note">
          {hidden ? 'Скрыт ' : ''}
          {hidden && review.hiddenAt ? when(review.hiddenAt) : ''}
          {hidden ? ' · ' : ''}
          Уникальных жалоб: {review.reports}
        </div>
        {/* кто пожаловался — не показываем никогда, ни админу: жалоба должна
            оставаться безопасной для того, кто её оставил */}
        {!!review.history.length && (
          <div className="shelf-note">
            Ранее: {review.history.map((h) => `${ACTION_TITLES[h.action] ?? h.action} (${h.reason})`).join('; ')}
          </div>
        )}
      </div>

      <div className="shelf-actions">
        {!hidden && (
          <ReasonAction
            label="Скрыть"
            icon="hide"
            busy={busy}
            placeholder="Почему скрываем — увидит автор"
            onSubmit={(reason) => onDecide('hide', reason)}
          />
        )}
        {hidden && (
          <button className="btn sm" disabled={busy} onClick={() => onDecide('restore')}>
            <Icon name="refresh" /> Вернуть
          </button>
        )}
        {!hidden && !!review.reports && (
          <button className="btn sm ghost" disabled={busy} onClick={() => onDecide('dismiss')}>
            Жалобы напрасны
          </button>
        )}
      </div>

      <div className="shelf-actions">
        <ReasonAction
          label="Удалить отзыв"
          icon="trash"
          busy={busy}
          confirm="Удалить отзыв? Восстановить его будет нельзя."
          placeholder="Почему удаляем — увидит автор"
          onSubmit={(reason) => onDecide('delete', reason)}
        />
        <button
          className="btn sm ghost narrow"
          disabled={busy}
          onClick={() => {
            haptic()
            setRestricting((v) => !v)
          }}
        >
          <Icon name="ban" /> Ограничить автора
        </button>
      </div>

      {restricting && (
        <div className="reason-form">
          <div className="field">
            <label>Что закрыть</label>
            <div className="chips">
              {SCOPES.map((s) => (
                <button
                  key={s.key}
                  className={`chip sm${scope === s.key ? ' active' : ''}`}
                  onClick={() => setScope(s.key)}
                >
                  {s.title}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>На сколько дней (пусто — бессрочно)</label>
            <input
              className="input"
              inputMode="numeric"
              value={days}
              onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))}
            />
          </div>
          <ReasonAction
            label="Ограничить"
            icon="ban"
            busy={busy}
            placeholder="Причина — увидит человек"
            onSubmit={(reason) => {
              setRestricting(false)
              onRestrict(scope, days ? Number(days) : null, reason)
            }}
          />
        </div>
      )}
    </div>
  )
}

/**
 * Кнопка, которая сначала спрашивает причину. Причина обязательна на сервере
 * для всех решений «против» человека, поэтому и здесь без текста не отправить —
 * иначе человек получил бы 400 после нажатия.
 */
function ReasonAction({
  label,
  icon,
  busy,
  placeholder,
  confirm,
  onSubmit,
}: {
  label: string
  icon: 'hide' | 'trash' | 'refresh' | 'ban'
  busy: boolean
  placeholder: string
  confirm?: string
  onSubmit: (reason: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')

  if (!open) {
    return (
      <button
        className="btn sm ghost narrow"
        disabled={busy}
        onClick={() => {
          haptic()
          setOpen(true)
        }}
      >
        <Icon name={icon} /> {label}
      </button>
    )
  }

  return (
    <div className="reason-form grow">
      <input
        className="input"
        autoFocus
        placeholder={placeholder}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="shelf-actions">
        <button
          className="btn sm"
          disabled={busy || !reason.trim()}
          onClick={async () => {
            if (confirm && !(await showConfirm(confirm))) return
            setOpen(false)
            onSubmit(reason.trim())
          }}
        >
          {label}
        </button>
        <button
          className="btn sm ghost narrow"
          disabled={busy}
          onClick={() => {
            setOpen(false)
            setReason('')
          }}
        >
          Отмена
        </button>
      </div>
    </div>
  )
}
