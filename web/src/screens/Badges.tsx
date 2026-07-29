import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Badge } from '../types'

/**
 * Значки библиотекаря на «Моей полке» (issue #11).
 *
 * Их видит только хозяин: публичный рейтинг превратил бы обмен книгами в
 * соревнование. Незаработанные показываем бледными и с прогрессом — это
 * подсказка, что делать дальше, а не упрёк за маленькую полку.
 */
export function Badges() {
  const [badges, setBadges] = useState<Badge[] | null>(null)

  useEffect(() => {
    let alive = true
    api
      .badges()
      .then((r) => alive && setBadges(r.badges))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  if (!badges?.length) return null
  const earned = badges.filter((b) => b.earned)
  // пока не заработан ни один значок, показывать витрину серых кружков грустно:
  // человек только пришёл, ему сначала нужна книга на полке, а не список наград
  if (!earned.length) return null

  return (
    <div className="badges">
      <div className="section-title">
        Ваши значки{' '}
        <span className="d muted">
          {earned.length} из {badges.length}
        </span>
      </div>
      <div className="badge-row">
        {badges.map((b) => (
          <div
            key={b.id}
            className={`badge${b.earned ? '' : ' locked'}`}
            title={b.earned ? b.hint : `${b.hint}: ${b.current} из ${b.target}`}
          >
            <span className="badge-emoji" aria-hidden="true">
              {b.emoji}
            </span>
            <span className="badge-title">{b.title}</span>
            <span className="badge-hint">
              {b.earned ? b.hint : `${b.current} из ${b.target}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
