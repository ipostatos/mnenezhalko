import type { LoanSummary } from '../types'
import { haptic } from '../telegram'

/**
 * Сводка «у кого мои книги»: одним взглядом видно, сколько книг гуляет
 * и как давно самая забытая. Показываем только когда есть что показать.
 */
export function MoodBoard({
  summary,
  onOpen,
}: {
  summary: LoanSummary | null
  /** без обработчика карточка просто информационная */
  onOpen?: () => void
}) {
  if (!summary?.active || !summary.mood) return null
  const { mood } = summary

  return (
    <div
      className={`mood-board level-${mood.level}${onOpen ? ' tappable' : ''}`}
      onClick={() => {
        if (!onOpen) return
        haptic()
        onOpen()
      }}
    >
      <div className="face">{mood.emoji}</div>
      <div className="grow">
        <div className="t">
          {summary.active === 1 ? 'Одна книга у читателя' : `Книг у читателей: ${summary.active}`}
        </div>
        <div className="d">
          «{summary.longestTitle}» — уже {summary.longestDays} дн., {mood.label}
          {summary.overdue > 0 && ` · просрочено: ${summary.overdue}`}
        </div>
      </div>
      <div className="mood-days">
        <div className="n">{summary.longestDays}</div>
        <div className="c">дн.</div>
      </div>
    </div>
  )
}
