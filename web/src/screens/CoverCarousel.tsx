import { useEffect, useRef, useState } from 'react'
import { haptic, hapticSelection } from '../telegram'

export type CarouselBook = { id: string; title: string; coverUrl: string }

/**
 * Коверфлоу-карусель обложек: центральная крупная, боковые меньше и бледнее.
 * Листается пальцем с инерцией (нативный momentum-скролл) и снапом по центру.
 *
 * Производительность:
 * - центры карточек меряем ОДИН раз (после раскладки и на resize), а на каждом
 *   кадре скролла только считаем расстояние и пишем стили — без чтения offsetLeft
 *   у каждого элемента (иначе браузер делает forced reflow десятки раз за кадр);
 * - `will-change` включаем только у карточек рядом с центром (класс near-center);
 * - тактильный «щёлк» — только при РУЧНОМ листании (при программном scrollTo молчим);
 * - центральную обложку и двух соседей грузим приоритетно (eager/high), остальные
 *   лениво (lazy/low), чтобы юзер быстрее увидел то, что в кадре;
 * - далёкую цель поиска подводим мгновенно, а не плавно «через всю ленту».
 */
export function CoverCarousel({
  books,
  onOpen,
  centerId,
}: {
  books: CarouselBook[]
  onOpen: (id: string) => void
  /** id книги, которую подвести в центр (например, найденную поиском) */
  centerId?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const rafId = useRef(0)
  const centeredIdx = useRef(-1)
  const centers = useRef<number[]>([]) // центр каждой карточки по X (кэш)
  const halfW = useRef(0) // половина ширины окна карусели (кэш)
  const programmatic = useRef(false) // идёт программный скролл → haptic молчит
  const progTimer = useRef(0)
  /**
   * Что не должно попасть в витрину (A3, ТЗ 5.08.2026):
   *  - книга вовсе без обложки — пустой слот в коверфлоу выглядит как поломка;
   *  - обложка, которая не загрузилась (битая ссылка, удалённый файл, 404 от
   *    нашего же прокси) — ловится onError и выбывает НАВСЕГДА, без повторов;
   *  - «нет фото» магазина — приходит как нормальная картинка с кодом 200,
   *    поэтому отсеивается на сервере (cover-quality.ts), сюда просто не дойдёт.
   * Ни один из случаев не оставляет дырку: карточка убирается целиком, а если
   * не осталось ни одной — карусели нет вовсе (см. `if (!shown.length)` ниже).
   */
  const [broken, setBroken] = useState<Set<string>>(new Set())
  const shown = books.filter((b) => b.coverUrl && !broken.has(b.id))

  // индекс, который окажется в центре на старте — по нему грузим приоритетные обложки
  const initialCenter =
    centerId && shown.findIndex((b) => b.id === centerId) >= 0
      ? shown.findIndex((b) => b.id === centerId)
      : Math.floor(shown.length / 2)

  // Единичный замер геометрии — только здесь читаем layout.
  const measure = () => {
    const el = ref.current
    if (!el) return
    halfW.current = el.clientWidth / 2
    const kids = Array.from(el.children) as HTMLElement[]
    centers.current = kids.map((c) => c.offsetLeft + c.offsetWidth / 2)
  }

  // Кадр скролла: без layout-чтений, только математика по кэшу + запись стилей.
  const update = () => {
    const el = ref.current
    const cs = centers.current
    if (!el || !cs.length) return
    const mid = el.scrollLeft + halfW.current
    const half = halfW.current || 1
    const kids = el.children as HTMLCollectionOf<HTMLElement>
    let nearest = 0
    let nearestPx = Infinity
    for (let i = 0; i < cs.length; i++) {
      const px = Math.abs(mid - cs[i])
      if (px < nearestPx) {
        nearestPx = px
        nearest = i
      }
      const child = kids[i]
      if (!child) continue
      const dist = Math.min(1, px / half)
      child.style.transform = `scale(${(1 - dist * 0.4).toFixed(3)})`
      child.style.opacity = (1 - dist * 0.55).toFixed(3)
      child.style.zIndex = String(1000 - Math.round(dist * 1000))
      // near-center: только соседи центра держат compositor-слой (will-change)
      child.classList.toggle('near-center', dist < 0.34)
    }
    // новая обложка встала в центр — лёгкий «щёлк», но не при программном скролле
    if (!programmatic.current && centeredIdx.current !== -1 && nearest !== centeredIdx.current)
      hapticSelection()
    centeredIdx.current = nearest
  }

  const onScroll = () => {
    cancelAnimationFrame(rafId.current)
    rafId.current = requestAnimationFrame(update)
  }

  useEffect(() => {
    const el = ref.current
    if (!el || !shown.length) return
    measure()
    const found = centerId ? shown.findIndex((b) => b.id === centerId) : -1
    const idx = found >= 0 ? found : Math.floor(shown.length / 2)
    const target = el.children[idx] as HTMLElement | undefined
    if (target) {
      const left = target.offsetLeft + target.offsetWidth / 2 - el.clientWidth / 2
      // далёкую цель подводим мгновенно — плавная анимация «через всю ленту»
      // спамит onScroll и выглядит как рывок; близкую найденную — плавно
      const far = Math.abs(left - el.scrollLeft) > el.clientWidth * 2
      const smooth = found >= 0 && !far
      // на время программного скролла глушим haptic
      programmatic.current = true
      clearTimeout(progTimer.current)
      progTimer.current = window.setTimeout(() => (programmatic.current = false), smooth ? 700 : 80)
      el.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' })
    }
    update()
    const onResize = () => {
      measure()
      update()
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(rafId.current)
      clearTimeout(progTimer.current)
      window.removeEventListener('resize', onResize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.length, centerId])

  if (!shown.length) return null

  return (
    <div className="cover-carousel" ref={ref} onScroll={onScroll}>
      {shown.map((b, i) => {
        const priority = Math.abs(i - initialCenter) <= 1
        return (
          <button
            key={b.id}
            className="cc-item"
            aria-label={b.title}
            onClick={() => {
              haptic()
              onOpen(b.id)
            }}
          >
            <img
              src={b.coverUrl}
              alt=""
              loading={priority ? 'eager' : 'lazy'}
              decoding="async"
              draggable={false}
              onError={() => setBroken((s) => new Set(s).add(b.id))}
              {...({ fetchpriority: priority ? 'high' : 'low' } as Record<string, string>)}
            />
          </button>
        )
      })}
    </div>
  )
}
