/**
 * Внутренний watchdog (`scripts/observe-alert.sh`).
 *
 * Проверяется не «скрипт запускается», а именно то, из-за чего такие watchdog'и
 * обычно выключают: он либо молчит, когда надо было позвать, либо будит людей
 * каждый час одним и тем же. Плюс граница приватности: в сообщение уходят только
 * агрегаты, а тексты, которые писали люди, остаются в journal.
 *
 * Сама проверка подменяется скриптом-заглушкой (`OBSERVE_CMD`), отправка —
 * командой-заглушкой (`OBSERVE_SEND_CMD`), время — `OBSERVE_NOW`. Настоящий путь
 * отправки через curl покрыт отдельным тестом с недоступным API.
 *
 * Запуск: npm run test -w server
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dirname, '../../scripts/observe-alert.sh')
const HOUR = 3600

/** Windows-путь → путь, понятный git-bash: C:\x\y → /c/x/y. */
const bashPath = (p: string) =>
  p.replace(/^([A-Za-z]):\\/, (_m, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/')

let dir: string
let sent: string
let stateDir: string

/** Есть ли рабочий bash: без него тестировать shell-скрипт нечем. */
const bashOk = (() => {
  const r = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' })
  return r.status === 0
})()

const has = (cmd: string) =>
  bashOk && spawnSync('bash', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'watchdog-'))
  stateDir = join(dir, 'state')
  sent = join(dir, 'sent.txt')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(dir, '.env'), 'BOT_TOKEN=123:test\nADMIN_IDS=111,222\n')
  writeFileSync(join(dir, '.release-env'), 'RELEASE_SHA=abcdef1234567890\nRELEASE_VERSION=0.2.0-beta.2\n')
})

after(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

beforeEach(() => {
  writeFileSync(sent, '')
  const s = join(stateDir, 'observe-state')
  if (existsSync(s)) rmSync(s)
})

/** Заглушка проверки: печатает заданный отчёт и отдаёт нужный код. */
function fakeCheck(report: string, code = 0) {
  const p = join(dir, 'check.sh')
  writeFileSync(p, `#!/usr/bin/env bash\ncat <<'REPORT'\n${report}\nREPORT\nexit ${code}\n`, {
    mode: 0o755,
  })
  return p
}

/** Один прогон watchdog'а. Возвращает код возврата, вывод и отправленное. */
function run(opts: { report: string; code?: number; now: number; extra?: Record<string, string> }) {
  fakeCheck(opts.report, opts.code ?? 0)
  const r = spawnSync('bash', [bashPath(SCRIPT)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OBSERVE_CMD: `${bashPath(join(dir, 'check.sh'))}`,
      OBSERVE_STATE_DIR: bashPath(stateDir),
      OBSERVE_ENV_FILE: bashPath(join(dir, '.env')),
      OBSERVE_RELEASE_ENV: bashPath(join(dir, '.release-env')),
      OBSERVE_LOCK: bashPath(join(dir, 'lock')),
      OBSERVE_NOW: String(opts.now),
      // заглушка отправки: пишет получателя и текст в файл
      OBSERVE_SEND_CMD: `{ echo "=== to $OBSERVE_CHAT_ID"; cat; echo; } >> ${bashPath(sent)}`,
      ...opts.extra,
    },
  })
  return {
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    sent: existsSync(sent) ? readFileSync(sent, 'utf8') : '',
  }
}

const NORMAL = '════ процесс ════\n  ✅ служба active\n\n✅ всё в норме'
const STUCK_MAIL = (n: number, hours: number) =>
  [
    '════ письма о решениях ════',
    `  🔴 не доставлено писем о решениях после трёх попыток: ${n}`,
    '════ бэкап ════',
    `  🔴 последний бэкап ${hours} ч назад (cron в 3:34)`,
    '',
    '🔴 инцидентов: 2, предупреждений: 0',
  ].join('\n')

test('норма: администраторам не приходит ничего', { skip: !bashOk }, () => {
  const r = run({ report: NORMAL, code: 0, now: 1_000_000 })
  assert.equal(r.status, 0)
  assert.equal(r.sent.trim(), '', 'в тишине watchdog молчит')
  assert.match(r.out, /норма, молчу/)
})

test('инцидент: сообщение уходит КАЖДОМУ администратору', { skip: !bashOk }, () => {
  const r = run({ report: STUCK_MAIL(1, 29), code: 1, now: 1_000_000 })
  assert.equal(r.status, 1, 'код возврата проверки сохраняется')
  assert.match(r.sent, /=== to 111/)
  assert.match(r.sent, /=== to 222/)
  assert.match(r.sent, /🔴 МнеНеЖалко: инцидент наблюдения/)
  assert.match(r.sent, /• не доставлено писем о решениях после трёх попыток: 1/)
  assert.match(r.sent, /• последний бэкап 29 ч назад/)
  // техника для разбора: чем работает прод и куда смотреть
  assert.match(r.sent, /Релиз: abcdef1/)
  assert.match(r.sent, /Версия: 0\.2\.0-beta\.2/)
  assert.match(r.sent, /journalctl -u mnenezhalko -n 100/)
  // строка-итог проверки в сообщение не попадает: это не отдельный инцидент
  assert.doesNotMatch(r.sent, /• инцидентов: 2/)
})

test('тот же инцидент через час: дубля нет', { skip: !bashOk }, () => {
  run({ report: STUCK_MAIL(1, 29), code: 1, now: 1_000_000 })
  writeFileSync(sent, '')
  const r = run({ report: STUCK_MAIL(1, 29), code: 1, now: 1_000_000 + HOUR })
  assert.equal(r.sent.trim(), '', 'о том же уже писали')
  assert.match(r.out, /о нём уже писали/)
})

test('выросшие числа — это тот же инцидент, а не новый', { skip: !bashOk }, () => {
  run({ report: STUCK_MAIL(1, 29), code: 1, now: 1_000_000 })
  writeFileSync(sent, '')
  // прошёл час: бэкапу уже 30 часов, писем стало 3 — проблема ТА ЖЕ
  const r = run({ report: STUCK_MAIL(3, 30), code: 1, now: 1_000_000 + HOUR })
  assert.equal(r.sent.trim(), '', 'числа в отпечаток не входят')
})

test('через шесть часов о нерешённом напоминаем', { skip: !bashOk }, () => {
  run({ report: STUCK_MAIL(1, 29), code: 1, now: 1_000_000 })
  writeFileSync(sent, '')
  const r = run({ report: STUCK_MAIL(1, 35), code: 1, now: 1_000_000 + 6 * HOUR })
  assert.match(r.sent, /инцидент не решён 6 ч/)
  assert.match(r.sent, /=== to 111/)
  assert.match(r.sent, /=== to 222/)
})

test('новый тип инцидента сообщается сразу, не дожидаясь напоминания', { skip: !bashOk }, () => {
  run({ report: STUCK_MAIL(1, 29), code: 1, now: 1_000_000 })
  writeFileSync(sent, '')
  const worse = `${STUCK_MAIL(1, 29)}\n  🔴 свободно 742 МБ — новые релизы не выкладывать`
  const r = run({ report: worse, code: 1, now: 1_000_000 + HOUR })
  assert.match(r.sent, /свободно 742 МБ/)
  assert.match(r.out, /набор изменился/)
})

test('восстановление: одно сообщение, дальше тишина', { skip: !bashOk }, () => {
  run({ report: STUCK_MAIL(1, 29), code: 1, now: 1_000_000 })
  writeFileSync(sent, '')

  const back = run({ report: NORMAL, code: 0, now: 1_000_000 + 2 * HOUR })
  assert.match(back.sent, /наблюдение снова в норме/)
  assert.equal((back.sent.match(/=== to /g) ?? []).length, 2, 'по одному каждому админу')

  writeFileSync(sent, '')
  const later = run({ report: NORMAL, code: 0, now: 1_000_000 + 3 * HOUR })
  assert.equal(later.sent.trim(), '', 'второго «восстановлено» не бывает')
})

test('в сообщение не уходят тексты, которые писали люди', { skip: !bashOk }, () => {
  // так выглядит отчёт, когда у джобы упала обработка книги: имя джобы —
  // инцидент, а текст ошибки с названием книги и ником идёт обычной строкой
  const report = [
    '════ джобы планировщика ════',
    '  🔴 джоба moderation-notices: ошибка (текст в journalctl)',
    '      текст ошибки: Forbidden: bot was blocked by @lizaveta — книга «Мастер и Маргарита»',
    '',
    '🔴 инцидентов: 1, предупреждений: 0',
  ].join('\n')
  const r = run({ report, code: 1, now: 1_000_000 })
  assert.match(r.sent, /джоба moderation-notices/, 'что сломалось — сообщаем')
  assert.doesNotMatch(r.sent, /lizaveta/, 'ник в Telegram не уходит')
  assert.doesNotMatch(r.sent, /Мастер и Маргарита/, 'название книги не уходит')
  assert.match(r.out, /Мастер и Маргарита/, 'в отчёте и journal подробности остаются')
})

test('недоставка одному администратору не отменяет остальных', { skip: !bashOk }, () => {
  const r = run({
    report: STUCK_MAIL(1, 29),
    code: 1,
    now: 1_000_000,
    // первому админу отправка падает, второму проходит
    extra: {
      OBSERVE_SEND_CMD: `if [ "$OBSERVE_CHAT_ID" = 111 ]; then exit 1; fi; { echo "=== to $OBSERVE_CHAT_ID"; cat; } >> ${bashPath(sent)}`,
    },
  })
  assert.match(r.sent, /=== to 222/, 'второй админ сообщение получил')
  assert.match(r.out, /отправлено 1, не удалось 1/)
})

test('недоступный Telegram API не роняет watchdog', { skip: !bashOk || !has('curl') }, () => {
  const r = run({
    report: STUCK_MAIL(1, 29),
    code: 1,
    now: 1_000_000,
    // настоящий путь отправки (curl), но API недостижим
    extra: { OBSERVE_SEND_CMD: '', TELEGRAM_API: 'http://127.0.0.1:9' },
  })
  assert.equal(r.status, 1, 'код возврата — от проверки, не от сбоя отправки')
  assert.match(r.out, /не смог написать админу 111/)
  assert.match(r.out, /не смог написать админу 222/)
  assert.match(r.out, /отправлено 0, не удалось 2/)
})

test('параллельный запуск блокируется', { skip: !bashOk || !has('flock') }, () => {
  const lock = join(dir, 'lock-busy')
  fakeCheck(NORMAL, 0)
  const env = {
    ...process.env,
    OBSERVE_CMD: bashPath(join(dir, 'check.sh')),
    OBSERVE_STATE_DIR: bashPath(stateDir),
    OBSERVE_ENV_FILE: bashPath(join(dir, '.env')),
    OBSERVE_RELEASE_ENV: bashPath(join(dir, '.release-env')),
    OBSERVE_LOCK: bashPath(lock),
    OBSERVE_NOW: '1000000',
    OBSERVE_SEND_CMD: 'cat > /dev/null',
  }
  // держим замок занятым 5 секунд и параллельно пробуем запустить проверку
  const out = execFileSync(
    'bash',
    [
      '-c',
      `flock -x ${bashPath(lock)} sleep 5 & sleep 0.3; bash ${bashPath(SCRIPT)}; wait`,
    ],
    { encoding: 'utf8', env },
  )
  assert.match(out, /предыдущая проверка ещё идёт/)
  assert.doesNotMatch(out, /всё в норме/, 'вторая проверка не выполнялась вовсе')
})
