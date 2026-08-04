/**
 * Свайп влево в два шага, как в iOS.
 *
 * Жест не удаляет: он фиксирует строку в открытом положении и показывает
 * корзину, удаление — только по тапу на неё (подтверждение спрашивает
 * вызывающий в `onAction`). Два шага здесь не формальность: список листают
 * пальцем, и одношаговый свайп рано или поздно снесёт строку в кармане.
 *
 * Вертикальный скролл не перехватываем: пока жест не признан горизонтальным
 * (сдвиг больше 8px и по X больше, чем по Y), страница листается как обычно.
 *
 * Портировано из «Общака» и отражено: там корзина слева и свайп вправо, здесь
 * наоборот — по просьбе владельца проекта и ближе к системному жесту.
 */
import { useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'

export function SwipeRow(props: { onAction: () => void; label?: string; children: ReactNode }) {
  /** насколько строка стоит открытой; ширина кнопки чуть больше — до края */
  const OPEN = 96
  /** дальше этого сдвига отпускание фиксирует строку открытой */
  const THRESHOLD = 56
  const MAX = 140

  const [dx, setDx] = useState(0)
  const [drag, setDrag] = useState(false)
  const [open, setOpen] = useState(false)
  const start = useRef({ x: 0, y: 0, active: false, horiz: false })
  const moved = useRef(false)
  // актуальный сдвиг для up(): state внутри замыкания отстаёт на кадр
  const dxRef = useRef(0)
  const openRef = useRef(false)

  function setOpenBoth(v: boolean) {
    openRef.current = v
    setOpen(v)
  }

  function down(e: React.PointerEvent) {
    start.current = { x: e.clientX, y: e.clientY, active: true, horiz: false }
    moved.current = false
    setDrag(true)
  }

  function move(e: React.PointerEvent) {
    const s = start.current
    if (!s.active) return
    const base = openRef.current ? OPEN : 0
    // влево — положительный сдвиг: дальше по коду это «насколько открыто»
    const ddx = s.x - e.clientX
    const ddy = e.clientY - s.y
    if (!s.horiz) {
      if (Math.abs(ddx) < 8) return
      if (Math.abs(ddy) > Math.abs(ddx)) {
        // жест оказался вертикальным — отдаём его скроллу страницы
        s.active = false
        setDrag(false)
        setDx(openRef.current ? OPEN : 0)
        return
      }
      s.horiz = true
      moved.current = true
      ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    }
    dxRef.current = Math.max(0, Math.min(base + ddx, MAX))
    setDx(dxRef.current)
  }

  function up() {
    const s = start.current
    const wasSwipe = s.active && s.horiz
    start.current = { x: 0, y: 0, active: false, horiz: false }
    setDrag(false)
    if (wasSwipe) setOpenBoth(dxRef.current >= THRESHOLD)
    setDx(openRef.current ? OPEN : 0)
    dxRef.current = openRef.current ? OPEN : 0
  }

  function act() {
    setOpenBoth(false)
    setDx(0)
    dxRef.current = 0
    props.onAction()
  }

  return (
    <div className="swipe-wrap">
      <button
        className="swipe-bg"
        style={{ opacity: dx > 8 || open ? 1 : 0 }}
        onClick={act}
        aria-label={props.label ?? 'Удалить'}
      >
        <Icon name="trash" />
      </button>
      <div
        style={{
          transform: `translateX(-${drag ? dx : open ? OPEN : 0}px)`,
          transition: drag ? 'none' : 'transform 0.2s',
        }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onClickCapture={(e) => {
          // тап, которым закончился свайп, не должен «нажать» строку
          if (moved.current) {
            e.stopPropagation()
            e.preventDefault()
            moved.current = false
            return
          }
          if (openRef.current) {
            // открытая строка: тап по ней просто закрывает
            e.stopPropagation()
            e.preventDefault()
            setOpenBoth(false)
            setDx(0)
            dxRef.current = 0
          }
        }}
      >
        {props.children}
      </div>
    </div>
  )
}
