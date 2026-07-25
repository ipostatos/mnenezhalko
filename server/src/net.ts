/**
 * Защита от SSRF при загрузке обложек. coverUrl приходит в том числе от
 * пользователя (форма добавления книги), поэтому подписать и скачать «любой
 * http(s)» нельзя — иначе подготовленный url вида http://169.254.169.254/…,
 * http://127.0.0.1:…, http://внутренний-сервис/ заставит сервер сходить внутрь
 * своей сети. Проверяем и литеральный IP, и результат DNS (в т.ч. на каждом
 * редиректе — иначе публичный домен может увести на приватный адрес).
 */
import { lookup } from 'node:dns/promises'

function ipv4ToLong(ip: string): number | null {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return null
  const p = m.slice(1).map(Number)
  if (p.some((n) => n > 255)) return null
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]
}

/** Приватный / служебный / нероутируемый адрес (то, что нельзя дёргать наружу). */
export function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (v.includes(':')) {
    // IPv6
    if (v === '::1' || v === '::') return true
    if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateIp(mapped[1])
    return false
  }
  const n = ipv4ToLong(v)
  if (n === null) return true // не распарсили как IPv4 — считаем небезопасным
  const inRange = (base: string, bits: number) => {
    const b = ipv4ToLong(base)!
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
    return (n & mask) === (b & mask)
  }
  return (
    inRange('0.0.0.0', 8) || // «этот» хост
    inRange('10.0.0.0', 8) ||
    inRange('100.64.0.0', 10) || // CGNAT
    inRange('127.0.0.0', 8) || // loopback
    inRange('169.254.0.0', 16) || // link-local (метаданные облака)
    inRange('172.16.0.0', 12) ||
    inRange('192.0.0.0', 24) ||
    inRange('192.168.0.0', 16) ||
    inRange('198.18.0.0', 15) || // бенчмарк-сети
    inRange('224.0.0.0', 4) || // multicast
    inRange('240.0.0.0', 4) // зарезервировано
  )
}

/**
 * Разбирает url и убеждается, что это http(s) на ПУБЛИЧНЫЙ адрес (резолвит DNS
 * и проверяет все адреса). Бросает при нарушении — вызывать перед каждым fetch,
 * в т.ч. на каждом hop редиректа.
 */
export async function assertPublicUrl(raw: string): Promise<void> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('bad_url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad_scheme')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  // литеральный IP отсекаем сразу; для имени приватность проверяем ПО РЕЗУЛЬТАТУ
  // DNS (isPrivateIp на самом имени вернул бы true для любого домена)
  const isIpLiteral = /^[\d.]+$/.test(host) || host.includes(':')
  if (isIpLiteral && isPrivateIp(host)) throw new Error('private_host')
  const addrs = await lookup(host, { all: true })
  if (!addrs.length) throw new Error('no_dns')
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error('private_host')
}

/**
 * Дешёвая синхронная проверка coverUrl при приёме от пользователя (без DNS) —
 * быстрый отказ на очевидно небезопасном. Полную проверку с DNS делает
 * assertPublicUrl уже при загрузке (в т.ч. защита от DNS-rebinding).
 */
export function isSafeCoverUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  )
    return false
  // литеральный IP (v4 или v6) — пускаем только публичный; обычные обложки по домену
  if (/^[\d.]+$/.test(host) || host.includes(':')) return !isPrivateIp(host)
  return true
}
