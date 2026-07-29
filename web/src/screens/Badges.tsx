import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Badge } from '../types'
import type { Route } from '../App'
import { haptic } from '../telegram'

/**
 * Значки библиотекаря (issue #11): лента на «Моей полке» и отдельный экран
 * «Мои достижения».
 *
 * Их видит только хозяин: публичный рейтинг превратил бы обмен книгами в
 * соревнование. Незаработанные показываем бледными и с прогрессом — это
 * подсказка, что делать дальше, а не упрёк за маленькую полку.
 *
 * Картинки нарисованы заказчиком (`web/public/ach/<id>.webp`, 320px webp из
 * исходных PNG по два мегабайта). Название значка уже написано НА картинке,
 * поэтому подпись под ней не дублируется — остаётся только подсказка.
 */
export function badgeImage(id: string): string {
  return `/ach/${id}.webp`
}

/** Карточка значка: картинка, а если она не дошла — запасной символ. */
function BadgeCard({ badge, big }: { badge: Badge; big?: boolean }) {
  const [broken, setBroken] = useState(false)
  const label = badge.earned ? badge.hint : `${badge.hint}: ${badge.current} из ${badge.target}`

  return (
    <div className={`badge${badge.earned ? '' : ' locked'}${big ? ' big' : ''}`} title={label}>
      {broken ? (
        <span className="badge-emoji" aria-hidden="true">
          {badge.emoji}
        </span>
      ) : (
        <img
          className="badge-img"
          src={badgeImage(badge.id)}
          alt={badge.title}
          loading="lazy"
          onError={() => setBroken(true)}
        />
      )}
      {/* у полученного значка подсказка «что сделать» звучала бы заданием,
          хотя дело уже сделано; само название написано на картинке */}
      <span className={`badge-hint${badge.earned ? ' got' : ''}`}>
        {badge.earned ? 'Получено' : `${badge.current} из ${badge.target}`}
      </span>
    </div>
  )
}

/**
 * Лента на «Моей полке»: только заработанные плюс ближайший недостающий, чтобы
 * было видно, куда двигаться. Полный список живёт на своём экране.
 */
export function Badges({ go }: { go?: (r: Route) => void }) {
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

  // ближайшая цель — та, до которой осталось меньше всего
  const next = badges
    .filter((b) => !b.earned)
    .sort((a, b) => b.current / b.target - a.current / a.target)[0]
  const shown = next ? [...earned, next] : earned

  return (
    <div className="badges">
      <div className="section-title">
        Мои достижения{' '}
        <span className="d muted">
          {earned.length} из {badges.length}
        </span>
      </div>
      <div className="badge-row">
        {shown.map((b) => (
          <BadgeCard key={b.id} badge={b} />
        ))}
      </div>
      {go && (
        <button
          className="link-btn"
          onClick={() => {
            haptic('light')
            go({ name: 'badges' })
          }}
        >
          Все достижения
        </button>
      )}
    </div>
  )
}

/** Отдельный экран со всеми достижениями. */
export function BadgesScreen() {
  const [badges, setBadges] = useState<Badge[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .badges()
      .then((r) => alive && setBadges(r.badges))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [])

  if (failed) {
    return <div className="error-banner">Не получилось открыть достижения. Попробуйте позже.</div>
  }
  if (!badges) return <div className="spinner">Загружаю…</div>

  const earned = badges.filter((b) => b.earned)

  return (
    <>
      <h1>Мои достижения</h1>
      <div className="sub">
        {earned.length
          ? `Получено ${earned.length} из ${badges.length}. Остальные ждут своего часа.`
          : 'Пока пусто. Первый значок появится, как только на полке окажется книга.'}
      </div>

      <div className="badge-grid">
        {badges.map((b) => (
          <BadgeCard key={b.id} badge={b} big />
        ))}
      </div>

      <div className="foot">
        Значки видите только вы: общего рейтинга библиотекарей в проекте нет.
      </div>
    </>
  )
}
