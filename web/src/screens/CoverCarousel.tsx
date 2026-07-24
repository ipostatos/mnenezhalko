import { useEffect, useRef, useState } from 'react'
import { haptic } from '../telegram'

export type CarouselBook = { id: string; title: string; coverUrl: string }

/**
 * Коверфлоу-карусель обложек: центральная крупная, боковые меньше и бледнее.
 * Листается пальцем с инерцией (нативный momentum-скролл) и снапом по центру;
 * масштаб каждой обложки пересчитывается по расстоянию до центра на каждом кадре.
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
  // обложки, которые не загрузились (битая ссылка) — убираем из карусели
  const [broken, setBroken] = useState<Set<string>>(new Set())
  const shown = books.filter((b) => !broken.has(b.id))

  const update = () => {
    const el = ref.current
    if (!el) return
    const mid = el.scrollLeft + el.clientWidth / 2
    const half = el.clientWidth / 2
    for (const child of Array.from(el.children) as HTMLElement[]) {
      const c = child.offsetLeft + child.offsetWidth / 2
      const dist = Math.min(1, Math.abs(mid - c) / half)
      const scale = 1 - dist * 0.4
      const opacity = 1 - dist * 0.55
      child.style.transform = `scale(${scale.toFixed(3)})`
      child.style.opacity = opacity.toFixed(3)
      child.style.zIndex = String(1000 - Math.round(dist * 1000))
    }
  }

  const onScroll = () => {
    cancelAnimationFrame(rafId.current)
    rafId.current = requestAnimationFrame(update)
  }

  useEffect(() => {
    const el = ref.current
    if (!el || !shown.length) return
    const found = centerId ? shown.findIndex((b) => b.id === centerId) : -1
    const idx = found >= 0 ? found : Math.floor(shown.length / 2)
    const target = el.children[idx] as HTMLElement | undefined
    if (target) {
      const left = target.offsetLeft + target.offsetWidth / 2 - el.clientWidth / 2
      // найденную книгу подводим плавно, стартовую середину — сразу
      el.scrollTo({ left, behavior: found >= 0 ? 'smooth' : 'auto' })
    }
    update()
    return () => cancelAnimationFrame(rafId.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.length, centerId])

  if (!shown.length) return null

  return (
    <div className="cover-carousel" ref={ref} onScroll={onScroll}>
      {shown.map((b) => (
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
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setBroken((s) => new Set(s).add(b.id))}
          />
        </button>
      ))}
    </div>
  )
}
