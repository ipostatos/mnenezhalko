import { useState } from 'react'
import { api } from '../api'
import type { Route } from '../App'
import type { Book } from '../types'
import { haptic } from '../telegram'
import { BookRow } from './BookRow'

/** Коды сервера — человеческим языком. */
const ERRORS: Record<string, string> = {
  too_many: 'Слишком много запросов подряд — переведите дух и попробуйте через минуту.',
  unauthorized: 'Откройте библиотеку из Telegram — так я пойму, кто вы.',
}

const IDEAS = [
  'хочу про любовь и приключения',
  'что-то лёгкое на вечер',
  'про космос и одиночество',
  'нонфикшн про деньги',
  'книгу для подростка',
]

export function Assistant({
  go,
  city,
  enabled,
}: {
  go: (r: Route) => void
  city?: string
  enabled: boolean
}) {
  const [text, setText] = useState('')
  const [intro, setIntro] = useState('')
  const [items, setItems] = useState<Book[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function ask(value: string) {
    const q = value.trim()
    if (q.length < 2) return
    haptic('medium')
    setLoading(true)
    setError('')
    try {
      const res = await api.ai(q, city)
      setIntro(res.intro)
      setItems(res.items)
    } catch (e: any) {
      setError(ERRORS[e.message] ?? e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <img className="illus" src="/il/mood.jpg" alt="" loading="lazy" />
      <div className="hero">
        <span className="logo">✨</span>
        <h1>Подбор книги</h1>
      </div>
      <div className="sub">
        Опишите настроение или тему — подберу книгу с полок библиотекарей и дам контакт владельца.
      </div>

      {!enabled && (
        <div className="warn-banner">
          ИИ-подбор пока не подключён — ищу по обычному совпадению слов.
        </div>
      )}

      <textarea
        className="input"
        rows={3}
        placeholder="Например: хочу сегодня почитать о любви и приключениях"
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={{ resize: 'none' }}
      />
      <div style={{ height: 'var(--sp-3)' }} />
      <button className="btn" disabled={loading || text.trim().length < 2} onClick={() => ask(text)}>
        {loading ? 'Ищу…' : '✨ Подобрать'}
      </button>

      {items === null && (
        <>
          <div className="section-title">Например</div>
          <div className="chips">
            {IDEAS.map((i) => (
              <button
                key={i}
                className="chip sm"
                onClick={() => {
                  setText(i)
                  ask(i)
                }}
              >
                {i}
              </button>
            ))}
          </div>
        </>
      )}

      {error && (
        <div className="error-banner" style={{ marginTop: 'var(--sp-4)' }}>
          {error}
        </div>
      )}

      {items && (
        <>
          <div className="section-title">{intro}</div>
          {items.length === 0 && (
            <div className="empty">
              <div className="big">🤷</div>
              Ничего похожего не нашлось. Попробуйте описать иначе.
            </div>
          )}
          {items.map((b) => (
            <BookRow key={b.id} book={b} onOpen={() => go({ name: 'book', id: b.id })} />
          ))}
        </>
      )}
    </>
  )
}
