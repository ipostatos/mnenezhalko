export const tg: any = (window as any).Telegram?.WebApp

export function initTelegram() {
  if (!tg) return
  tg.ready()
  tg.expand()
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
