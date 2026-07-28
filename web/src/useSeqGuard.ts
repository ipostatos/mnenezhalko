import { useRef } from 'react'

/**
 * Защита от stale-ответов: когда фильтр/экран сменился, а медленный старый
 * запрос доехал позже нового, он не должен перезаписать свежие данные.
 * Использование: const id = guard.next() перед запросом; в then —
 * if (!guard.isCurrent(id)) return.
 */
export function useSeqGuard() {
  const seq = useRef(0)
  return useRef({
    next: () => ++seq.current,
    isCurrent: (id: number) => id === seq.current,
  }).current
}
