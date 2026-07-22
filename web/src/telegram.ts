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
}

export function haptic(style: 'light' | 'medium' | 'success' = 'light') {
  if (style === 'success') tg?.HapticFeedback?.notificationOccurred?.('success')
  else tg?.HapticFeedback?.impactOccurred?.(style)
}

export function openTg(url: string) {
  if (tg?.openTelegramLink && url.startsWith('https://t.me/')) tg.openTelegramLink(url)
  else if (tg?.openLink) tg.openLink(url)
  else window.open(url, '_blank')
}

export function showAlert(message: string) {
  if (tg?.showAlert) tg.showAlert(message)
  else alert(message)
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
