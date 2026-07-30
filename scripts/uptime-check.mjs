#!/usr/bin/env node
/**
 * Внешний uptime-монитор. Запускается НЕ на нашей машине (расписание GitHub
 * Actions, см. `.github/workflows/uptime.yml`) и стучится в прод снаружи —
 * ровно тот класс поломок, который внутренний watchdog увидеть не может
 * по построению: смерть машины, пропажа сети, протухший сертификат, мёртвый
 * Caddy. Нет машины — нет и внутренней проверки, а этот запуск состоится.
 *
 * Только чтение публичных адресов. Единственная запись — отметка
 * `POST /api/monitor/ping` (по токену): по ней уже ВНУТРЕННЯЯ проверка видит,
 * что снаружи кто-то стучится, то есть двое сторожат друг друга.
 *
 * Запуск руками:
 *   node scripts/uptime-check.mjs
 *   MONITOR_URL=https://… node scripts/uptime-check.mjs
 *
 * Код возврата: 0 — норма или только предупреждения, 1 — инцидент.
 *
 * ⚠️ Репозиторий публичный, поэтому журнал запуска виден всем: в отчёт идут
 * только те данные, которые и так отдаёт публичный `/api/health`. Токены
 * (ping, бот) уходят в заголовки и в тело запроса, но никогда в вывод.
 */
import tls from 'node:tls'
import { createHash } from 'node:crypto'

const DEFAULT_URL = 'https://mnenezhalko-46-224-220-94.sslip.io'

/** Пороги в одном месте: их читают и тесты, и отчёт. */
export const LIMITS = {
  /** каталог живой: меньше — значит база подменилась или синк снёс всё */
  minBooks: 100,
  /** ответ health медленнее — предупреждение (инцидентом не делаем: бывает холодный старт) */
  slowMs: 2500,
  /** сертификат: меньше 14 дней — предупреждение, меньше 3 — инцидент */
  certWarnDays: 14,
  certBadDays: 3,
  /** сколько раз пробуем, прежде чем объявить инцидент, и пауза между попытками */
  attempts: 3,
  retryMs: 15_000,
  /** напоминание о нерешённом инциденте */
  remindMs: 6 * 60 * 60 * 1000,
}

/* ──────────────────────────── разбор показаний ─────────────────────────── */

/**
 * Превращает снятые показания в строки отчёта. Чистая функция: сеть уже
 * отработала, здесь только решение «норма / предупреждение / инцидент».
 *
 * @param {object} probe
 * @param {{status?: number, json?: any, ms?: number, error?: string}} probe.health
 * @param {{status?: number, html?: string, error?: string}} [probe.app]
 * @param {{status?: number, url?: string, error?: string}} [probe.asset]
 * @param {{daysLeft?: number, error?: string}} [probe.cert]
 */
export function evaluate(probe, limits = LIMITS) {
  const lines = []
  const bad = (text) => lines.push({ level: 'bad', text })
  const warn = (text) => lines.push({ level: 'warn', text })
  const ok = (text) => lines.push({ level: 'ok', text })

  const h = probe.health || {}
  if (h.error) {
    bad(`health не ответил снаружи: ${h.error}`)
  } else if (h.status !== 200) {
    bad(`health ответил кодом ${h.status}`)
  } else if (!h.json || typeof h.json !== 'object') {
    bad('health ответил не JSON — отвечает не приложение (Caddy, заглушка, чужой сайт)')
  } else if (h.json.ok !== true) {
    bad('health отвечает ok:false')
  } else {
    const books = Number(h.json.books ?? 0)
    if (!Number.isFinite(books) || books < limits.minBooks) {
      bad(`в каталоге ${books} книг — меньше порога ${limits.minBooks}`)
    } else {
      const sha = String(h.json.sha ?? '').slice(0, 7) || '?'
      ok(`health отвечает: версия ${h.json.version ?? '?'}, релиз ${sha}, книг ${books}`)
    }
    if (h.json.version === 'dev' || h.json.version === 'unknown') {
      warn(`версия «${h.json.version}» — релиз выложен мимо release.sh`)
    }
    if (Number(h.ms) > limits.slowMs) warn(`health отвечал ${h.ms} мс`)
  }

  const app = probe.app
  if (app) {
    if (app.error) bad(`Mini App не открывается: ${app.error}`)
    else if (app.status !== 200) bad(`Mini App отдала код ${app.status}`)
    else if (!/<script[^>]+src="[^"]*\/assets\//.test(app.html || ''))
      bad('в Mini App нет ссылки на собранный скрипт — выложена пустая или чужая страница')
    else ok('Mini App открывается')
  }

  const asset = probe.asset
  if (asset) {
    // страница может отдаваться, а сборка рядом отсутствовать: тогда человек
    // видит белый экран, а health при этом бодро отвечает ok
    if (asset.error) bad(`скрипт Mini App не отдаётся: ${asset.error}`)
    else if (asset.status !== 200) bad(`скрипт Mini App отдал код ${asset.status}`)
    else ok('скрипт Mini App на месте')
  }

  const cert = probe.cert
  if (cert) {
    if (cert.error) warn(`сертификат не прочитан: ${cert.error}`)
    else if (cert.daysLeft <= limits.certBadDays)
      bad(`сертификат истекает через ${cert.daysLeft} дн — обновление Caddy не сработало`)
    else if (cert.daysLeft <= limits.certWarnDays)
      warn(`сертификат истекает через ${cert.daysLeft} дн`)
    else ok(`сертификат действителен ещё ${cert.daysLeft} дн`)
  }

  return {
    lines,
    incidents: lines.filter((l) => l.level === 'bad').map((l) => l.text),
    warnings: lines.filter((l) => l.level === 'warn').map((l) => l.text),
  }
}

/**
 * Отпечаток набора инцидентов. Числа выбиты намеренно: «сертификат истекает
 * через 2 дн» и «через 1 дн» — одна и та же проблема, иначе каждое расписание
 * выглядело бы как новая и будило людей заново (та же грабля, что у внутреннего
 * watchdog'а).
 */
export function fingerprintOf(incidents) {
  if (!incidents.length) return 'ok'
  const norm = incidents
    .map((s) => s.replace(/\d+/g, 'N'))
    .sort()
    .join('\n')
  return createHash('sha256').update(norm).digest('hex').slice(0, 16)
}

/**
 * Писать или молчать. Состояния хранить негде (у расписания нет своей памяти),
 * поэтому решение выводится из ИСТОРИИ прошлых запусков этого же расписания:
 * GitHub помнит их сам.
 *
 * @param {object} p
 * @param {boolean} p.incident            есть ли инцидент сейчас
 * @param {Array<{conclusion: string, startedAt: number}>} p.history прошлые запуски, новые первыми
 * @param {number} p.now                  время текущего запуска, мс
 * @param {number} [p.remindMs]           через сколько напоминать
 * @returns {'alert'|'reminder'|'recovery'|'silent'}
 */
export function decide({ incident, history, now, remindMs = LIMITS.remindMs }) {
  const past = (history || []).filter((r) => r.conclusion === 'success' || r.conclusion === 'failure')
  const prev = past[0]

  if (!incident) {
    // «снова в норме» — ровно один раз, и только если было о чём сообщать
    return prev && prev.conclusion === 'failure' ? 'recovery' : 'silent'
  }
  if (!prev || prev.conclusion !== 'failure') return 'alert'

  // инцидент продолжается: считаем, когда он начался, и напоминаем раз в remindMs.
  // Момент напоминания вычисляем по границе, а не по «времени последней отправки»:
  // хранить его негде, а граница одинаково видна каждому запуску.
  let firstFail = prev.startedAt
  for (const run of past) {
    if (run.conclusion !== 'failure') break
    firstFail = run.startedAt
  }
  const passedNow = Math.floor((now - firstFail) / remindMs)
  const passedPrev = Math.floor((prev.startedAt - firstFail) / remindMs)
  return passedNow > passedPrev && passedNow > 0 ? 'reminder' : 'silent'
}

/** Текст для Telegram: только агрегаты и техника, ничего личного. */
export function buildMessage(kind, { incidents, warnings = [], url, now = Date.now(), hoursDown = 0 }) {
  const stamp = new Date(now).toISOString().replace('T', ' ').slice(0, 16)
  const where = `Адрес: ${url}\nВремя: ${stamp} UTC\nПроверка идёт снаружи (GitHub Actions)`
  if (kind === 'recovery') {
    return `✅ МнеНеЖалко: снаружи снова отвечает\n\nИнцидентов нет.\n\n${where}`
  }
  const head =
    kind === 'reminder'
      ? `🔴 МнеНеЖалко: снаружи не в порядке уже ${hoursDown} ч`
      : '🔴 МнеНеЖалко: проверка снаружи нашла инцидент'
  const body = incidents.map((s) => `• ${s}`).join('\n')
  const tail = warnings.length ? `\n\nПредупреждения:\n${warnings.map((s) => `• ${s}`).join('\n')}` : ''
  return `${head}\n\n${body}${tail}\n\n${where}`
}

/* ──────────────────────────── снятие показаний ─────────────────────────── */

async function timedFetch(url, opts = {}, timeoutMs = 12_000) {
  const started = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'follow' })
    const text = await res.text()
    return { status: res.status, text, ms: Date.now() - started }
  } catch (e) {
    // причина отказа важнее стека: «сертификат», «нет адреса», «таймаут»
    return { error: String(e?.cause?.code || e?.code || e?.name || e), ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/** Сколько дней осталось сертификату. Caddy обновляет сам — но именно «сам» и ломается тихо. */
export function certDaysLeft(host, port = 443, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate()
      socket.end()
      if (!cert || !cert.valid_to) return resolve({ error: 'сертификат не получен' })
      const daysLeft = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000)
      resolve({ daysLeft })
    })
    socket.on('timeout', () => {
      socket.destroy()
      resolve({ error: 'таймаут' })
    })
    socket.on('error', (e) => resolve({ error: String(e?.code || e?.message || e) }))
  })
}

/** Один полный обход: health, страница, её скрипт, сертификат. */
export async function probeOnce(base) {
  const health = await timedFetch(`${base}/api/health`)
  let json
  if (health.text) {
    try {
      json = JSON.parse(health.text)
    } catch {
      json = undefined
    }
  }

  const app = await timedFetch(`${base}/`)
  let asset
  const src = /<script[^>]+src="([^"]*\/assets\/[^"]+)"/.exec(app.text || '')
  if (src) {
    const assetUrl = src[1].startsWith('http') ? src[1] : `${base}${src[1]}`
    const got = await timedFetch(assetUrl)
    asset = { status: got.status, error: got.error, url: assetUrl }
  }

  const cert = base.startsWith('https://') ? await certDaysLeft(new URL(base).hostname) : undefined

  return {
    health: { status: health.status, json, ms: health.ms, error: health.error },
    app: { status: app.status, html: app.text, error: app.error },
    asset,
    cert,
  }
}

/* ─────────────────────── ручной прогон против расписания ────────────────── */

/**
 * Ручной прогон — это диагностика, а не наблюдение. Смешивать их нельзя
 * в обе стороны:
 *
 *   • ручной зелёный прогон посреди аварии выглядел бы «предыдущий запуск
 *     успешен» и следующее расписание прислало бы ВТОРУЮ тревогу о том же;
 *   • ручной прогон против заведомо сломанного адреса (проверка письма от
 *     GitHub) разбудил бы людей настоящей тревогой.
 *
 * Поэтому решение о сообщении принимается только по запускам расписания.
 * `MONITOR_FORCE_NOTIFY=1` — осознанно проверить сам путь отправки.
 */
export function isScheduled(env = process.env) {
  return env.GITHUB_EVENT_NAME === 'schedule'
}

export function shouldNotify({ scheduled, force }) {
  return Boolean(scheduled || force)
}

/* ──────────────────────────────── история ──────────────────────────────── */

/**
 * Оставляет от ответа GitHub только то, из чего складывается состояние
 * наблюдения: завершённые запуски ПО РАСПИСАНИЮ, кроме текущего.
 */
export function parseRuns(data, { currentRunId } = {}) {
  return (data?.workflow_runs || [])
    .filter((r) => r.event === 'schedule')
    .filter((r) => String(r.id) !== String(currentRunId))
    .map((r) => ({ conclusion: r.conclusion, startedAt: new Date(r.run_started_at).getTime() }))
    .sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * Прошлые запуски этого же расписания. Токен даёт сам GitHub, права только
 * на чтение. Не получилось прочитать — считаем историю пустой: лучше лишнее
 * сообщение, чем молчание из-за сбоя вспомогательного запроса.
 */
export async function fetchHistory(env = process.env) {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_WORKFLOW_REF } = env
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_WORKFLOW_REF) return []
  // GITHUB_WORKFLOW_REF = owner/repo/.github/workflows/uptime.yml@refs/heads/main
  const file = GITHUB_WORKFLOW_REF.split('@')[0].split('/').pop()
  // event=schedule просим у самого GitHub, чтобы 30 записей не заняли ручные прогоны
  const url = `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/${file}/runs?per_page=30&status=completed&event=schedule`
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
    })
    if (!res.ok) return []
    return parseRuns(await res.json(), { currentRunId: GITHUB_RUN_ID })
  } catch {
    return []
  }
}

/* ──────────────────────────────── отправка ─────────────────────────────── */

async function sendTelegram(text, env) {
  const token = env.MONITOR_BOT_TOKEN
  const chat = env.MONITOR_CHAT_ID
  if (!token || !chat) {
    console.log('монитор: Telegram не настроен (нет MONITOR_BOT_TOKEN/MONITOR_CHAT_ID) —')
    console.log('           сигналом остаётся упавшая проверка и письмо GitHub владельцу репозитория')
    return
  }
  let sent = 0
  for (const id of chat.split(',').map((s) => s.trim()).filter(Boolean)) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: id, text, disable_web_page_preview: true }),
      })
      if (res.ok) sent += 1
      else console.log(`монитор: Telegram отказал кодом ${res.status}`)
    } catch (e) {
      // не роняем проверку из-за недоставки: результат уже есть в коде возврата
      console.log(`монитор: не отправилось (${String(e?.cause?.code || e?.name || e)})`)
    }
  }
  console.log(`монитор: отправлено сообщений — ${sent}`)
}

/**
 * Отметка «снаружи заходили»: по ней внутренняя проверка поймёт, что монитор жив.
 * Источник передаётся честно: живым наблюдением считается только расписание,
 * иначе один ручной прогон раз в месяц маскировал бы выключенное расписание.
 */
async function pingBack(base, token, source) {
  if (!token) return
  try {
    const res = await fetch(`${base}/api/monitor/ping?source=${encodeURIComponent(source)}`, {
      method: 'POST',
      headers: { 'x-monitor-token': token },
    })
    console.log(
      res.ok
        ? `монитор: отметка о заходе принята (${source})`
        : `монитор: отметка отклонена (${res.status})`,
    )
  } catch {
    console.log('монитор: отметку отправить не удалось')
  }
}

/* ───────────────────────────────── запуск ──────────────────────────────── */

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`

if (isMain) {
  const env = process.env
  const base = (env.MONITOR_URL || DEFAULT_URL).replace(/\/+$/, '')
  const limits = { ...LIMITS, minBooks: Number(env.MONITOR_MIN_BOOKS || LIMITS.minBooks) }

  // одна неудачная попытка это ещё не инцидент: перезапуск сервиса, разрыв
  // соединения у бегуна, секундная просадка сети. Будим людей только тогда,
  // когда не отвечает подряд.
  let result
  for (let attempt = 1; attempt <= limits.attempts; attempt++) {
    result = evaluate(await probeOnce(base), limits)
    if (!result.incidents.length) break
    if (attempt < limits.attempts) {
      console.log(`попытка ${attempt}: ${result.incidents.length} инцидент(ов), повтор через ${limits.retryMs / 1000} с`)
      await new Promise((r) => setTimeout(r, limits.retryMs))
    }
  }

  const scheduled = isScheduled(env)
  console.log(`════ внешняя проверка ${base} (${scheduled ? 'по расписанию' : 'ручной прогон'}) ════`)
  for (const line of result.lines) {
    console.log(`  ${line.level === 'bad' ? '🔴' : line.level === 'warn' ? '⚠️ ' : '✅'} ${line.text}`)
  }

  const incident = result.incidents.length > 0
  const history = await fetchHistory(env)
  const now = Date.now()
  const notify = shouldNotify({ scheduled, force: env.MONITOR_FORCE_NOTIFY === '1' })
  const action = notify ? decide({ incident, history, now, remindMs: limits.remindMs }) : 'silent'

  if (!notify) {
    console.log('монитор: ручной прогон — сообщения не шлём (MONITOR_FORCE_NOTIFY=1, чтобы проверить отправку)')
  }

  if (action !== 'silent') {
    const firstFail = history.find((r) => r.conclusion === 'success')?.startedAt
    const hoursDown = firstFail ? Math.round((now - firstFail) / 3_600_000) : 0
    await sendTelegram(
      buildMessage(action === 'recovery' ? 'recovery' : action, {
        incidents: result.incidents,
        warnings: result.warnings,
        url: base,
        now,
        hoursDown,
      }),
      env,
    )
  } else {
    console.log('монитор: сообщение не нужно (нового ничего)')
  }

  if (!incident) await pingBack(base, env.MONITOR_PING_TOKEN, scheduled ? 'schedule' : 'manual')

  console.log('')
  if (incident) {
    console.log(`🔴 инцидентов: ${result.incidents.length}, предупреждений: ${result.warnings.length}`)
    process.exit(1)
  }
  console.log(result.warnings.length ? `⚠️  предупреждений: ${result.warnings.length}` : '✅ снаружи всё в норме')
}
