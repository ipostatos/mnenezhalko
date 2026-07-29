import { Component, type ReactNode } from 'react'
import { MAIN_CHAT } from '../links'

/**
 * Последняя защита Mini App: ошибка в отрисовке любого экрана роняла всё
 * приложение в белый экран, и человек не понимал, сломалось приложение,
 * интернет или его телефон. React такие ошибки наружу не отдаёт, перехватить
 * их можно только классовым компонентом.
 *
 * Экран-заглушка даёт три вещи: понятный текст, кнопку «Открыть заново» и
 * короткий код происшествия, который человек может назвать в чате, чтобы мы
 * нашли ровно его случай.
 */
type State = { error: Error | null; code: string }

/** Короткий код происшествия: время открытия + случайные символы. */
function incidentCode(): string {
  const t = Date.now().toString(36).slice(-4)
  const r = Math.random().toString(36).slice(2, 5)
  return `${t}-${r}`.toUpperCase()
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, code: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, code: incidentCode() }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // в консоль WebView: через отладку Telegram это единственный способ увидеть,
    // что именно упало на телефоне у человека
    console.error('[mini-app] экран упал:', this.state.code, error, info?.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="empty">
        <img className="illus sm" src="/il/bee.jpg" alt="" />
        <h1>Приложение не открылось</h1>
        <div className="sub">
          Что-то сломалось на нашей стороне. Ваши книги и выдачи на месте: это
          сбой самого экрана, а не ваших данных.
        </div>
        <div style={{ height: 'var(--sp-4)' }} />
        <button className="btn" onClick={() => window.location.reload()}>
          Открыть заново
        </button>
        <div style={{ height: 'var(--sp-2)' }} />
        <button className="btn ghost" onClick={() => window.open(MAIN_CHAT, '_blank')}>
          Написать в чат проекта
        </button>
        <div className="foot">
          Если повторится, назовите в чате код: <b>{this.state.code}</b>
        </div>
      </div>
    )
  }
}
