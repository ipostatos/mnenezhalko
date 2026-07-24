export const tg: any = (window as any).Telegram?.WebApp

export function initTelegram() {
  // жест «щипок» и двойной тап на iOS зумят страницу мимо viewport-правил
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false })
  }
  let lastTouch = 0
  document.addEventListener(
    'touchend',
    (e) => {
      const now = Date.now()
      if (now - lastTouch <= 300) e.preventDefault()
      lastTouch = now
    },
    { passive: false },
  )

  if (!tg) return
  tg.ready()
  tg.expand()
  // свайп вниз должен листать список, а не закрывать приложение
  tg.disableVerticalSwipes?.()
  // шапка и фон Mini App — под фирменный кремовый, чтобы не выбивались из макета
  try {
    tg.setBackgroundColor?.('#f7f1e8')
    tg.setHeaderColor?.('#f7f1e8')
    tg.setBottomBarColor?.('#f7f1e8')
  } catch {}
}

/**
 * Вызывает fn, когда Mini App снова становится видимым (вернулись из фона или
 * переключились обратно во вкладку) — чтобы обновить данные, а не показывать
 * устаревшие. Возвращает функцию отписки для cleanup в useEffect.
 */
export function onAppShow(fn: () => void) {
  const handler = () => {
    if (document.visibilityState === 'visible') fn()
  }
  document.addEventListener('visibilitychange', handler)
  return () => document.removeEventListener('visibilitychange', handler)
}

export function haptic(style: 'light' | 'medium' | 'success' = 'light') {
  if (style === 'success') tg?.HapticFeedback?.notificationOccurred?.('success')
  else tg?.HapticFeedback?.impactOccurred?.(style)
}

/** Лёгкий «щёлк» смены выбора — для колеса/карусели при прокрутке. */
export function hapticSelection() {
  tg?.HapticFeedback?.selectionChanged?.()
}

export function openTg(url: string) {
  if (tg?.openTelegramLink && url.startsWith('https://t.me/')) tg.openTelegramLink(url)
  else if (tg?.openLink) tg.openLink(url)
  else window.open(url, '_blank')
}

/**
 * Нативный платёжный лист Telegram Stars. Резолвится статусом из колбэка
 * (`paid` | `cancelled` | `failed` | `pending`); вне Telegram — `unsupported`.
 */
export function openInvoice(link: string): Promise<string> {
  return new Promise((resolve) => {
    if (tg?.openInvoice) tg.openInvoice(link, (status: string) => resolve(status))
    else resolve('unsupported')
  })
}

export function showAlert(message: string) {
  if (tg?.showAlert) tg.showAlert(message)
  else alert(message)
}

/** Нативное подтверждение Telegram (да/отмена). */
export function showConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (tg?.showConfirm) tg.showConfirm(message, (ok: boolean) => resolve(ok))
    else resolve(window.confirm(message))
  })
}

export function backButton(visible: boolean, onBack: () => void) {
  if (!tg?.BackButton) return () => {}
  if (!visible) {
    tg.BackButton.hide()
    return () => {}
  }
  tg.BackButton.show()
  tg.BackButton.onClick(onBack)
  return () => {
    tg.BackButton.offClick(onBack)
    tg.BackButton.hide()
  }
}
