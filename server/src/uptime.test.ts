/**
 * Внешний uptime-монитор (`scripts/uptime-check.mjs`).
 *
 * Проверяется не «скрипт запускается», а два свойства, из-за которых мониторинг
 * обычно оказывается бесполезным:
 *   1. он ПРОПУСКАЕТ поломку, которая видна только снаружи (страница отдаётся,
 *      а сборки рядом нет; health отвечает не JSON, потому что отвечает Caddy);
 *   2. он БУДИТ людей каждые десять минут одним и тем же, и его выключают.
 *
 * Сеть не трогаем: показания в проверку передаются готовыми, история запусков —
 * массивом. Живой путь (fetch, tls, отправка) покрыт ручным прогоном на проде.
 *
 * Запуск: npm run test -w server
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { evaluate, fingerprintOf, decide, buildMessage, parseRuns, isScheduled, shouldNotify, LIMITS } =
  await import(pathToFileURL(resolve(import.meta.dirname, '../../scripts/uptime-check.mjs')).href)

const HOUR = 3600_000

/** Показания одного обхода — ровно то, что собирает `probeOnce`. */
type Probe = {
  health: { status?: number; ms?: number; json?: any; error?: string }
  app?: { status?: number; html?: string; error?: string }
  asset?: { status?: number; url?: string; error?: string }
  cert?: { daysLeft?: number; error?: string }
}

/** Здоровый ответ прода: от него отталкиваются все «сломанные» варианты. */
const healthy = (): Probe => ({
  health: {
    status: 200,
    ms: 300,
    json: { ok: true, books: 3254, version: '0.2.0-beta.2', sha: 'eb3e840aaaa' },
  },
  app: { status: 200, html: '<script type="module" src="/assets/index-abc123.js"></script>' },
  asset: { status: 200, url: 'https://example/assets/index-abc123.js' },
  cert: { daysLeft: 60 },
})

test('здоровый прод не даёт ни одного инцидента', () => {
  const r = evaluate(healthy())
  assert.deepEqual(r.incidents, [])
  assert.deepEqual(r.warnings, [])
})

test('сервер не ответил — инцидент', () => {
  const probe = healthy()
  probe.health = { error: 'ECONNREFUSED' }
  const r = evaluate(probe)
  assert.equal(r.incidents.length, 1)
  assert.match(r.incidents[0], /health не ответил снаружи/)
})

test('на месте приложения отвечает что-то другое (не JSON) — инцидент', () => {
  // так выглядит подменённый Caddy-блок или страница-заглушка хостинга:
  // код 200 есть, «жив» по нему сказать нельзя
  const probe = healthy()
  probe.health = { status: 200, ms: 100, json: undefined }
  const r = evaluate(probe)
  assert.match(r.incidents[0], /не JSON/)
})

test('пустой каталог — инцидент, даже когда health бодро отвечает ok', () => {
  const probe = healthy()
  probe.health.json.books = 0
  const r = evaluate(probe)
  assert.match(r.incidents[0], /в каталоге 0 книг/)
})

test('страница есть, а собранного скрипта рядом нет — инцидент (белый экран)', () => {
  const probe = healthy()
  probe.asset = { status: 404, url: 'https://example/assets/index-abc123.js' }
  const r = evaluate(probe)
  assert.match(r.incidents[0], /скрипт Mini App отдал код 404/)
})

test('в странице нет ссылки на сборку — инцидент', () => {
  const probe = healthy()
  probe.app = { status: 200, html: '<html><body>hello</body></html>' }
  probe.asset = undefined
  const r = evaluate(probe)
  assert.match(r.incidents[0], /нет ссылки на собранный скрипт/)
})

test('сертификат: 10 дней — предупреждение, 2 дня — инцидент', () => {
  const soon = healthy()
  soon.cert = { daysLeft: 10 }
  assert.deepEqual(evaluate(soon).incidents, [])
  assert.match(evaluate(soon).warnings[0], /через 10 дн/)

  const late = healthy()
  late.cert = { daysLeft: 2 }
  assert.match(evaluate(late).incidents[0], /обновление Caddy не сработало/)
})

test('медленный ответ и версия dev — предупреждения, а не побудка', () => {
  const probe = healthy()
  probe.health.ms = LIMITS.slowMs + 1
  probe.health.json.version = 'dev'
  const r = evaluate(probe)
  assert.deepEqual(r.incidents, [])
  assert.equal(r.warnings.length, 2)
})

test('отпечаток не меняется от чисел внутри одной и той же проблемы', () => {
  // «истекает через 2 дн» и «через 1 дн» — одна проблема; иначе каждый обход
  // выглядел бы как новый инцидент и будил людей заново
  assert.equal(
    fingerprintOf(['сертификат истекает через 2 дн']),
    fingerprintOf(['сертификат истекает через 1 дн']),
  )
  assert.notEqual(fingerprintOf(['health не ответил']), fingerprintOf(['сертификат истекает']))
  assert.equal(fingerprintOf([]), 'ok')
})

test('первый инцидент — сообщаем сразу', () => {
  const now = Date.now()
  const history = [{ conclusion: 'success', startedAt: now - 10 * 60_000 }]
  assert.equal(decide({ incident: true, history, now }), 'alert')
})

test('истории нет вовсе (первый запуск) — тоже сообщаем', () => {
  assert.equal(decide({ incident: true, history: [], now: Date.now() }), 'alert')
})

test('тот же инцидент продолжается — молчим', () => {
  const now = Date.now()
  const history = [
    { conclusion: 'failure', startedAt: now - 10 * 60_000 },
    { conclusion: 'failure', startedAt: now - 20 * 60_000 },
    { conclusion: 'success', startedAt: now - 30 * 60_000 },
  ]
  assert.equal(decide({ incident: true, history, now }), 'silent')
})

test('шесть часов без решения — одно напоминание, дальше снова молчим', () => {
  const now = Date.now()
  const start = now - 6 * HOUR
  const history = []
  for (let t = now - 10 * 60_000; t >= start; t -= 10 * 60_000) {
    history.push({ conclusion: 'failure', startedAt: t })
  }
  history.push({ conclusion: 'success', startedAt: start - 10 * 60_000 })
  assert.equal(decide({ incident: true, history, now }), 'reminder')

  // следующий обход через десять минут — граница шести часов уже пройдена
  const later = now + 10 * 60_000
  history.unshift({ conclusion: 'failure', startedAt: now })
  assert.equal(decide({ incident: true, history, now: later }), 'silent')
})

test('стало хорошо после инцидента — одно «снова в норме», потом тишина', () => {
  const now = Date.now()
  const afterFailure = [{ conclusion: 'failure', startedAt: now - 10 * 60_000 }]
  assert.equal(decide({ incident: false, history: afterFailure, now }), 'recovery')

  const afterSuccess = [{ conclusion: 'success', startedAt: now - 10 * 60_000 }]
  assert.equal(decide({ incident: false, history: afterSuccess, now }), 'silent')
})

test('отменённые и пропущенные запуски не считаются ни падением, ни нормой', () => {
  // GitHub отменяет запуски при перегрузке очереди: считать отмену «восстановлением»
  // значило бы прислать «снова в норме» посреди аварии
  const now = Date.now()
  const history = [
    { conclusion: 'cancelled', startedAt: now - 10 * 60_000 },
    { conclusion: 'failure', startedAt: now - 20 * 60_000 },
  ]
  assert.equal(decide({ incident: true, history, now }), 'silent')
  assert.equal(decide({ incident: false, history, now }), 'recovery')
})

test('в состояние наблюдения идут только запуски по расписанию', () => {
  // ручной зелёный прогон посреди аварии выглядел бы «предыдущий успешен»,
  // и следующее расписание прислало бы вторую тревогу о том же самом
  const runs = parseRuns(
    {
      workflow_runs: [
        { id: 3, event: 'workflow_dispatch', conclusion: 'success', run_started_at: '2026-07-30T12:00:00Z' },
        { id: 2, event: 'schedule', conclusion: 'failure', run_started_at: '2026-07-30T11:50:00Z' },
        { id: 1, event: 'schedule', conclusion: 'success', run_started_at: '2026-07-30T11:40:00Z' },
      ],
    },
    { currentRunId: 4 },
  )
  assert.deepEqual(
    runs.map((r: { conclusion: string }) => r.conclusion),
    ['failure', 'success'],
  )
  const now = Date.parse('2026-07-30T12:10:00Z')
  assert.equal(decide({ incident: true, history: runs, now }), 'silent')
})

test('текущий запуск не попадает в собственную историю', () => {
  const runs = parseRuns(
    {
      workflow_runs: [
        { id: 9, event: 'schedule', conclusion: null, run_started_at: '2026-07-30T12:00:00Z' },
        { id: 8, event: 'schedule', conclusion: 'success', run_started_at: '2026-07-30T11:50:00Z' },
      ],
    },
    { currentRunId: 9 },
  )
  assert.equal(runs.length, 1)
  assert.equal(runs[0].conclusion, 'success')
})

test('ручной прогон молчит, расписание пишет, принудительная проверка отправки пишет', () => {
  assert.equal(shouldNotify({ scheduled: false, force: false }), false)
  assert.equal(shouldNotify({ scheduled: true, force: false }), true)
  // иначе диагностический прогон против заведомо сломанного адреса разбудил бы людей
  assert.equal(shouldNotify({ scheduled: false, force: true }), true)
  assert.equal(isScheduled({ GITHUB_EVENT_NAME: 'schedule' }), true)
  assert.equal(isScheduled({ GITHUB_EVENT_NAME: 'workflow_dispatch' }), false)
  assert.equal(isScheduled({}), false)
})

test('в сообщение не попадает ничего, кроме техники', () => {
  const text = buildMessage('alert', {
    incidents: ['health не ответил снаружи: ECONNREFUSED'],
    warnings: [],
    url: 'https://mnenezhalko-46-224-220-94.sslip.io',
    now: Date.UTC(2026, 6, 30, 12, 0),
  })
  assert.match(text, /инцидент/)
  assert.match(text, /ECONNREFUSED/)
  assert.match(text, /снаружи/)
  // адрес прода публичен, а вот токенов и личного в шаблоне нет по построению
  assert.doesNotMatch(text, /token|@|tgId/i)
})
