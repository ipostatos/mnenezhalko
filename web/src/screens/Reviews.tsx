import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Rating, Review, ReviewsPayload } from '../types'
import { haptic, showAlert } from '../telegram'
import { plural } from '../plural'

/**
 * Оценки и короткие аннотации в карточке книги (issue #18).
 *
 * Форма показывается только тем, кто книгу читал: право проверяет сервер
 * (`canReview`), фронт лишь не рисует лишнюю кнопку. Тексты чужих отзывов
 * видны всем, потому что в этом и смысл: выбирать книгу по мнению людей из
 * проекта, а не по обложке.
 */
export function Reviews({ bookId }: { bookId: string }) {
  const [data, setData] = useState<ReviewsPayload | null>(null)
  const [failed, setFailed] = useState(false)
  const [rating, setRating] = useState(0)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [thanks, setThanks] = useState(false)

  useEffect(() => {
    let alive = true
    setFailed(false)
    api
      .reviews(bookId)
      .then((r) => {
        if (!alive) return
        setData(r)
        setRating(r.myReview?.rating ?? 0)
        setText(r.myReview?.text ?? '')
      })
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [bookId])

  // блок отзывов — не главное на экране: если он не загрузился, карточка книги
  // должна остаться рабочей, а не показывать ошибку во весь экран
  if (failed) return null
  if (!data) return null

  const apply = (r: { rating: Rating; items: Review[] }) => {
    const mine = r.items.find((x) => x.mine) ?? null
    setData({ ...data, rating: r.rating, items: r.items, myReview: mine })
    setRating(mine?.rating ?? 0)
    setText(mine?.text ?? '')
  }

  async function save() {
    if (!rating || saving) return
    setSaving(true)
    setError('')
    try {
      apply(await api.saveReview(bookId, { rating, text: text.trim() || null }))
      haptic('success')
      setThanks(true)
    } catch (e: any) {
      setError(errorText(e?.message, data!.textMax))
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    setSaving(true)
    setError('')
    try {
      apply(await api.deleteReview(bookId))
      setThanks(false)
    } catch (e: any) {
      setError(errorText(e?.message, data!.textMax))
    } finally {
      setSaving(false)
    }
  }

  async function report(id: string) {
    haptic()
    const hide = () => setData({ ...data!, items: data!.items.filter((r) => r.id !== id) })
    try {
      await api.reportReview(id)
      hide()
    } catch (e: any) {
      // повторная жалоба того же человека теперь честно отбивается сервером;
      // для нажавшего это не ошибка — его жалоба уже учтена, отзыв убираем
      if (e?.message === 'already_reported') return hide()
      if (e?.message === 'too_many') {
        return showAlert('Слишком много жалоб подряд. Попробуйте позже.')
      }
      /* остальное молча: экран из-за жалобы ломаться не должен */
    }
  }

  const { rating: avg, items, canReview, myReview, textMax, signed } = data
  const others = items.filter((r) => !r.mine)

  return (
    <>
      <div className="section-title">Что говорят читатели</div>

      <div className="card rating-head">
        {avg.avg !== null ? (
          <>
            <div className="rating-avg">
              <b>{avg.avg.toFixed(1)}</b>
              <Stars value={Math.round(avg.avg)} />
            </div>
            <div className="d muted">
              {avg.count} {plural(avg.count, ['оценка', 'оценки', 'оценок'])}
            </div>
          </>
        ) : (
          <div className="d muted">
            {canReview
              ? 'Эту книгу ещё никто не оценил. Будете первым?'
              : 'Эту книгу ещё никто не оценил.'}
          </div>
        )}
      </div>

      {canReview && (
        <div className="card review-form">
          <div className="d" style={{ marginBottom: 'var(--sp-2)' }}>
            {myReview ? 'Ваша оценка' : 'Вы читали эту книгу — поставьте оценку'}
          </div>
          <div className="stars-pick">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                className={`star-btn ${n <= rating ? 'on' : ''}`}
                aria-label={`Оценка ${n} из 5`}
                aria-pressed={n === rating}
                onClick={() => {
                  haptic()
                  setRating(n)
                  setThanks(false)
                }}
              >
                {n <= rating ? '★' : '☆'}
              </button>
            ))}
          </div>

          <textarea
            className="input"
            rows={3}
            maxLength={textMax}
            placeholder="Пара слов о книге — увидят все. Можно пропустить."
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setThanks(false)
            }}
          />
          <div className="d muted" style={{ textAlign: 'right' }}>
            {text.length}/{textMax}
          </div>

          {error && <div className="warn-banner">{error}</div>}
          {thanks && !error && <div className="ok-banner">Спасибо, записал.</div>}

          <button className="btn" onClick={save} disabled={!rating || saving}>
            {saving ? 'Сохраняю…' : myReview ? 'Обновить оценку' : 'Оценить книгу'}
          </button>
          {myReview && (
            <>
              <div style={{ height: 'var(--sp-2)' }} />
              <button className="btn ghost" onClick={remove} disabled={saving}>
                Удалить мою оценку
              </button>
            </>
          )}
        </div>
      )}

      {myReview && <ReviewCard review={myReview} />}
      {others.map((r) => (
        // жалоба уходит с подписью Telegram: без неё кнопку не показываем,
        // чтобы она не отвечала «unauthorized» тому, кто читает каталог со стороны
        <ReviewCard key={r.id} review={r} onReport={signed ? () => report(r.id) : undefined} />
      ))}

      {!canReview && items.length === 0 && (
        <div className="foot">Оценку ставит тот, кто держал книгу в руках.</div>
      )}
    </>
  )
}

function ReviewCard({ review, onReport }: { review: Review; onReport?: () => void }) {
  return (
    <div className="card review-card">
      <div className="review-top">
        <div className="avatar sm">{review.authorName.slice(0, 1).toUpperCase()}</div>
        <div className="grow">
          <div className="t-sm" style={{ fontWeight: 700 }}>
            {review.mine ? 'Вы' : review.authorName}
          </div>
          <Stars value={review.rating} />
        </div>
        {onReport && (
          <button className="link-btn" onClick={onReport} aria-label="Пожаловаться на отзыв">
            Пожаловаться
          </button>
        )}
      </div>
      {review.text && <p className="review-text">{review.text}</p>}
    </div>
  )
}

/** Звёзды как текст: читается голосовым доступом и не тянет иконочный шрифт. */
export function Stars({ value }: { value: number }) {
  const n = Math.max(0, Math.min(5, Math.round(value)))
  return (
    <span className="stars" aria-label={`${n} из 5`}>
      {'★'.repeat(n)}
      <span className="stars-off">{'★'.repeat(5 - n)}</span>
    </span>
  )
}


/** Коды ошибок сервера — человеческим языком. */
function errorText(code: string | undefined, textMax: number): string {
  const map: Record<string, string> = {
    not_read: 'Оценку ставит тот, кто книгу читал.',
    bad_rating: 'Выберите оценку от одной до пяти звёзд.',
    text_too_long: `Слишком длинно: не больше ${textMax} знаков.`,
    links_not_allowed: 'Ссылки в отзывах не публикуем — уберите ссылку.',
    unauthorized: 'Откройте приложение из Telegram, чтобы оценивать книги.',
  }
  return map[code ?? ''] ?? 'Не получилось сохранить. Попробуйте ещё раз.'
}
