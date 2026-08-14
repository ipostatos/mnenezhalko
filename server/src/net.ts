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

/**
 * Разбирает IPv6 в восемь групп по 16 бит. null — это не IPv6 (или мусор),
 * и такой ответ обязан трактоваться как «небезопасно» (см. isPrivateIp).
 *
 * Разбор нужен именно полный: сравнение адреса со строковым шаблоном не
 * работает, потому что одна и та же машина записывается многими способами, а
 * `new URL()` ещё и нормализует запись. Так и был пропущен обход, найденный
 * аудитом 14.08.2026: `http://[::ffff:127.0.0.1]/` доезжает до проверки уже
 * как `::ffff:7f00:1`, и шаблон с точечной записью не совпадал никогда.
 */
function parseIpv6(input: string): number[] | null {
  // zone id (fe80::1%eth0) к самому адресу не относится
  let s = input.split('%')[0]
  if (!s.includes(':')) return null

  // встроенный IPv4 в последних 32 битах: ::ffff:1.2.3.4, ::1.2.3.4, 64:ff9b::1.2.3.4
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (tail) {
    const n = ipv4ToLong(tail[1])
    if (n === null) return null
    const hi = ((n >>> 16) & 0xffff).toString(16)
    const lo = (n & 0xffff).toString(16)
    s = s.slice(0, -tail[1].length) + `${hi}:${lo}`
  }

  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : []
  let groups: string[]
  if (halves.length === 2) {
    const zeros = 8 - head.length - rest.length
    if (zeros < 1) return null // «::» обязано сжимать хотя бы одну группу
    groups = [...head, ...Array(zeros).fill('0'), ...rest]
  } else {
    groups = head
  }
  if (groups.length !== 8) return null

  const out: number[] = []
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    out.push(parseInt(g, 16))
  }
  return out
}

/** Приватный / служебный / нероутируемый адрес (то, что нельзя дёргать наружу). */
export function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (v.includes(':')) {
    const g = parseIpv6(v)
    // не разобрали как IPv6 — считаем небезопасным, как и нераспознанный IPv4
    if (!g) return true
    const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0)
    // IPv4 внутри адреса судим по правилам IPv4: и mapped (::ffff:a.b.c.d),
    // и compatible (::a.b.c.d), и NAT64, и 6to4 ведут на ту же машину
    const embedded = (hi: number, lo: number) =>
      isPrivateIp(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
    if (zeroUpTo(5) && g[5] === 0xffff) return embedded(g[6], g[7]) // ::ffff:0:0/96
    if (zeroUpTo(6)) return embedded(g[6], g[7]) // ::/96 (в т.ч. :: и ::1)
    // NAT64 (64:ff9b::/96): нули между префиксом и встроенным IPv4
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
      return embedded(g[6], g[7])
    if (g[0] === 0x2002) return embedded(g[1], g[2]) // 6to4
    if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
    if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
    if ((g[0] & 0xff00) === 0xff00) return true // ff00::/8 multicast
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true // 100::/64 discard
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

export type ResolvedAddr = { address: string; family: 4 | 6 }

/**
 * Разбирает url и убеждается, что это http(s) на ПУБЛИЧНЫЙ адрес (резолвит DNS
 * и проверяет все адреса). Бросает при нарушении — вызывать перед каждым fetch,
 * в т.ч. на каждом hop редиректа.
 *
 * ВАЖНО (DNS rebinding / TOCTOU): резолвит DNS сама и возвращает проверенные
 * адреса — вызывающий код обязан подключаться именно к ним (через
 * `connect.lookup` в undici, см. imgcache.ts), а не резолвить хост заново.
 * Если бы `fetch()` потом сам резолвил hostname второй раз, атакующий
 * DNS-сервер с TTL=0 мог бы на первый (проверочный) запрос ответить публичным
 * адресом, а на второй (для реального соединения) — приватным: проверка
 * прошла бы, а соединение всё равно ушло бы внутрь сети.
 */
export async function assertPublicUrl(raw: string): Promise<ResolvedAddr[]> {
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
  if (isIpLiteral) {
    // литеральный IP в URL — резолвить нечего, сам адрес и есть цель подключения
    const family = host.includes(':') ? 6 : 4
    return [{ address: host, family }]
  }
  const addrs = await lookup(host, { all: true })
  if (!addrs.length) throw new Error('no_dns')
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error('private_host')
  return addrs.map((a) => ({ address: a.address, family: a.family as 4 | 6 }))
}

/**
 * fetch с жёстким таймаутом. Все внешние вызовы (Notion, Telegram-файлы) обязаны
 * идти через него: зависший запрос без AbortController замораживал синк-цикл
 * целиком — следующий прогон планируется только после завершения текущего.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (e: any) {
    if (ctrl.signal.aborted) throw new Error(`timeout_${timeoutMs}ms`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Читает тело ответа с обрывом ПО ХОДУ чтения, а не после полной буферизации:
 * origin, приславший гигабайты (или без Content-Length), не должен целиком
 * осесть в памяти процесса, прежде чем мы заметим превышение.
 */
export async function readBodyLimited(res: Response, maxBytes: number): Promise<Buffer> {
  if (Number(res.headers.get('content-length') || 0) > maxBytes) throw new Error('too_large')
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) throw new Error('too_large')
    return buf
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error('too_large')
      }
      chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }
  return Buffer.concat(chunks)
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
