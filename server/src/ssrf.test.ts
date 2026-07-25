/**
 * SSRF-фильтр обложек, полный набор краевых случаев (stage 8 текущего аудита).
 * Проверяет и адресную матрицу, и защиту от DNS rebinding (TOCTOU между
 * проверкой и соединением), и SSRF-проверку на КАЖДОМ hop редиректа.
 * Запуск: npm run test -w server
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DISABLE_BOT = '1'

const { isPrivateIp, isSafeCoverUrl, assertPublicUrl } = await import('./net.js')
const { safeFetch } = await import('./imgcache.js')

// ── адресная матрица ────────────────────────────────────────────

test('isPrivateIp: блокирует весь набор приватных/служебных диапазонов', () => {
  const blocked = [
    '127.0.0.1', '127.1.2.3', '127.255.255.254', // loopback /8 целиком
    '0.0.0.0', '0.1.2.3', // «этот» хост /8
    '10.0.0.1', '10.255.255.255', // RFC1918
    '172.16.0.1', '172.31.255.255', // RFC1918
    '192.168.0.1', '192.168.255.255', // RFC1918
    '169.254.169.254', // link-local: метаданные AWS/GCP
    '169.254.0.1',
    '100.64.0.1', // CGNAT
    '198.18.0.1', // бенчмарк
    '224.0.0.1', '239.255.255.255', // multicast
    '240.0.0.1', '255.255.255.255', // зарезервировано
    '::1', '::', // IPv6 loopback
    'fe80::1', // IPv6 link-local
    'fc00::1', 'fd12:3456::1', // IPv6 unique-local
    '::ffff:127.0.0.1', '::ffff:169.254.169.254', // IPv4-mapped IPv6
  ]
  for (const ip of blocked) assert.equal(isPrivateIp(ip), true, `должен быть заблокирован: ${ip}`)
})

test('isPrivateIp: пропускает публичные адреса', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '192.169.0.1', '2606:4700::1111'])
    assert.equal(isPrivateIp(ip), false, `должен быть разрешён: ${ip}`)
})

test('isPrivateIp: нераспарсенное считается небезопасным (fail-closed)', () => {
  // не IPv4 и не IPv6 — «не знаю» должно значить «нельзя», а не «можно»
  for (const junk of ['', 'not-an-ip', '999.999.999.999', '1.2.3', '1.2.3.4.5'])
    assert.equal(isPrivateIp(junk), true, `неизвестное должно блокироваться: ${junk}`)
})

test('isSafeCoverUrl: блокирует служебные имена, схемы и приватные литералы', () => {
  const blocked = [
    'http://localhost/x.jpg',
    'http://sub.localhost/x.jpg',
    'http://printer.local/x.jpg',
    'http://db.internal/x.jpg',
    'http://127.0.0.1/x.jpg',
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://[::1]/x.jpg',
    'http://[fe80::1]/x.jpg',
    'ftp://example.com/x.jpg',
    'file:///etc/passwd',
    'gopher://example.com/',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    'not a url',
    '',
  ]
  for (const u of blocked) assert.equal(isSafeCoverUrl(u), false, `должен быть отклонён: ${u}`)
})

test('isSafeCoverUrl: пропускает обычные публичные обложки', () => {
  for (const u of [
    'https://s1.livelib.ru/boocover/1/o/a/b.jpeg',
    'http://example.com/cover.png',
    'https://www.knizka.pl/userdata/public/gfx/1.jpg',
  ])
    assert.equal(isSafeCoverUrl(u), true, `должен быть разрешён: ${u}`)
})

test('альтернативные записи IP (decimal/hex/octal/короткая) не обходят фильтр', () => {
  // WHATWG URL нормализует такие записи в dotted-quad ДО нашей проверки —
  // тест фиксирует это поведение: если парсер когда-нибудь перестанет
  // нормализовать, обход стал бы возможен и тест это поймает
  const cases: [string, string][] = [
    ['http://2130706433/x.jpg', '127.0.0.1'], // decimal
    ['http://0x7f000001/x.jpg', '127.0.0.1'], // hex
    ['http://0177.0.0.1/x.jpg', '127.0.0.1'], // octal
    ['http://127.1/x.jpg', '127.0.0.1'], // короткая форма
    ['http://0/x.jpg', '0.0.0.0'], // 0 → «этот» хост
  ]
  for (const [url, expectedHost] of cases) {
    assert.equal(new URL(url).hostname, expectedHost, `${url} должен нормализоваться в ${expectedHost}`)
    assert.equal(isSafeCoverUrl(url), false, `${url} должен быть заблокирован`)
  }
})

test('assertPublicUrl: url с username:password отвергается фильтром приёма', () => {
  // credentials в URL — способ запутать парсер («@» отделяет userinfo от хоста):
  // http://expected.com@127.0.0.1/ ведёт на 127.0.0.1, а не на expected.com
  assert.equal(isSafeCoverUrl('http://example.com@127.0.0.1/x.jpg'), false)
  assert.equal(isSafeCoverUrl('http://user:pass@127.0.0.1/x.jpg'), false)
  assert.equal(isSafeCoverUrl('http://user:pass@10.0.0.1/x.jpg'), false)
})

test('assertPublicUrl: чужие схемы и мусор бросают, приватный литерал бросает private_host', async () => {
  await assert.rejects(() => assertPublicUrl('ftp://example.com/x.jpg'), /bad_scheme/)
  await assert.rejects(() => assertPublicUrl('file:///etc/passwd'), /bad_scheme/)
  await assert.rejects(() => assertPublicUrl('не url'), /bad_url/)
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1/x.jpg'), /private_host/)
  await assert.rejects(() => assertPublicUrl('http://169.254.169.254/'), /private_host/)
  await assert.rejects(() => assertPublicUrl('http://[::1]/x.jpg'), /private_host/)
})

test('assertPublicUrl: возвращает проверенные адреса — их и надо использовать для соединения', async () => {
  // ключевой контракт против DNS rebinding: функция не просто «ок/не ок»,
  // а отдаёт КОНКРЕТНЫЕ адреса, к которым разрешено подключаться
  const addrs = await assertPublicUrl('http://93.184.216.34/x.jpg')
  assert.deepEqual(addrs, [{ address: '93.184.216.34', family: 4 }])
  for (const a of addrs) assert.equal(isPrivateIp(a.address), false)
})

// ── редиректы: проверка на каждом hop ───────────────────────────

/** Фейковый ответ-редирект/успех, без реальной сети. */
function fakeRes(status: number, location?: string): Response {
  return {
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'location' ? (location ?? null) : null) },
  } as unknown as Response
}

test('редирект с публичного origin на приватный IP блокируется на втором hop', async () => {
  const visited: string[] = []
  const hop = async (url: string) => {
    visited.push(url)
    // первый hop (публичный литерал) уводит на метаданные облака
    if (visited.length === 1) return fakeRes(302, 'http://169.254.169.254/latest/meta-data/')
    return fakeRes(200)
  }
  await assert.rejects(
    () => safeFetch('http://93.184.216.34/cover.jpg', new AbortController().signal, hop),
    /private_host/,
    'редирект на link-local должен быть отвергнут, а не пройден',
  )
  assert.equal(visited.length, 1, 'до приватного адреса соединение доходить не должно')
})

test('редирект на localhost блокируется', async () => {
  const hop = async () => fakeRes(301, 'http://127.0.0.1:8080/admin')
  await assert.rejects(
    () => safeFetch('http://93.184.216.34/cover.jpg', new AbortController().signal, hop),
    /private_host/,
  )
})

test('редирект на другую схему (file://) блокируется', async () => {
  const hop = async () => fakeRes(302, 'file:///etc/passwd')
  await assert.rejects(
    () => safeFetch('http://93.184.216.34/cover.jpg', new AbortController().signal, hop),
    /bad_scheme/,
  )
})

test('цепочка редиректов обрывается по лимиту hop, а не крутится вечно', async () => {
  let n = 0
  const hop = async () => {
    n++
    return fakeRes(302, 'http://93.184.216.34/next' + n)
  }
  const res = await safeFetch('http://93.184.216.34/start', new AbortController().signal, hop)
  assert.equal(res, null, 'слишком длинная цепочка → null')
  assert.ok(n <= 4, `hop-ов должно быть не больше 4, было ${n}`)
})

test('обычный публичный редирект проходит и отдаёт финальный ответ', async () => {
  const visited: string[] = []
  const hop = async (url: string) => {
    visited.push(url)
    if (visited.length === 1) return fakeRes(302, 'http://8.8.8.8/final.jpg')
    return fakeRes(200)
  }
  const res = await safeFetch('http://93.184.216.34/start.jpg', new AbortController().signal, hop)
  assert.equal(res?.status, 200)
  assert.deepEqual(visited, ['http://93.184.216.34/start.jpg', 'http://8.8.8.8/final.jpg'])
})

test('редирект без Location не уводит никуда — отдаём сам ответ', async () => {
  const hop = async () => fakeRes(302, undefined)
  const res = await safeFetch('http://93.184.216.34/x.jpg', new AbortController().signal, hop)
  assert.equal(res?.status, 302)
})

// ── DNS rebinding (TOCTOU) ──────────────────────────────────────

test('DNS rebinding: соединение идёт на ПРОВЕРЕННЫЙ адрес, хост повторно не резолвится', async () => {
  // Подтверждаем контракт: safeFetch передаёт в слой соединения именно те
  // адреса, которые вернул assertPublicUrl. Если бы соединение резолвило имя
  // заново, атакующий DNS с TTL=0 отдал бы публичный адрес на проверку и
  // приватный — на соединение, и вся проверка была бы формальной.
  const seen: { address: string; family: number }[][] = []
  const hop = async (_url: string, addrs: any) => {
    seen.push(addrs)
    return fakeRes(200)
  }
  await safeFetch('http://93.184.216.34/x.jpg', new AbortController().signal, hop)
  assert.equal(seen.length, 1, 'адреса должны передаваться в слой соединения')
  assert.deepEqual(seen[0], [{ address: '93.184.216.34', family: 4 }])
  for (const a of seen[0]) assert.equal(isPrivateIp(a.address), false)
})
