/**
 * Персистентный планировщик периодических задач (напоминания, housekeeping).
 *
 * Голый `setInterval` от старта процесса здесь не годится: первый прогон не
 * выполняется вовсе, а каждый деплой (рестарт) обнуляет таймер — при частых
 * деплоях джоба не отрабатывает НИ РАЗУ. Ровно эта грабля уже была у синка
 * (поймано на проде 2026-07-25, см. sync.ts) и у напоминаний о просрочке
 * (поймано аудитом 2026-07-28: просроченные выдачи есть, событий reminded — ноль).
 *
 * Поэтому: срок следующего запуска считается от последнего УСПЕШНОГО прогона,
 * записанного в базе (SyncState `job:<имя>:*`), а не от старта процесса. При
 * старте просроченная джоба выполняется сразу после короткой загрузочной паузы.
 */
import { prisma } from './db.js'

/** Пауза после старта: сначала подняться и начать отвечать, потом фоновые джобы. */
export const JOB_BOOT_DELAY_MS = 30_000

/** База повторной попытки после ошибки: 5 мин, 10, 20… но не дольше периода. */
export const JOB_RETRY_BASE_MS = 5 * 60_000

const stateKey = (name: string, field: string) => `job:${name}:${field}`

async function writeState(name: string, field: string, value: string): Promise<void> {
  const key = stateKey(name, field)
  await prisma.syncState
    .upsert({ where: { key }, create: { key, value }, update: { value } })
    .catch(() => {}) // учёт не должен ронять саму джобу
}

export async function readJobState(name: string, field: string): Promise<string | null> {
  const row = await prisma.syncState
    .findUnique({ where: { key: stateKey(name, field) } })
    .catch(() => null)
  return row?.value ?? null
}

/**
 * Сколько ждать до следующего запуска. Семантика та же, что у nextSyncDelayMs:
 * ещё не бегали / метка битая или из будущего → сразу после загрузочной паузы;
 * иначе — остаток периода от последнего успешного прогона, но не меньше паузы.
 */
export function nextJobDelayMs(
  lastSuccessIso: string | null,
  now: number,
  periodMs: number,
  bootDelayMs = JOB_BOOT_DELAY_MS,
): number {
  if (!lastSuccessIso) return bootDelayMs
  const last = Date.parse(lastSuccessIso)
  if (!Number.isFinite(last) || last > now) return bootDelayMs
  return Math.max(bootDelayMs, last + periodMs - now)
}

/** Пауза перед повтором после ошибки: растёт вдвое, но не дольше периода. */
export function jobRetryDelayMs(
  failures: number,
  periodMs: number,
  base = JOB_RETRY_BASE_MS,
): number {
  const backoff = base * 2 ** Math.max(0, failures - 1)
  return Math.min(periodMs, backoff)
}

export type JobDef = {
  /** имя в ключах SyncState и логах; менять нельзя — потеряется отсчёт */
  name: string
  periodMs: number
  bootDelayMs?: number
  /** сам прогон; вернувшаяся строка попадает в лог как сводка */
  run: () => Promise<string | void>
  log?: (msg: string) => void
  logError?: (msg: string) => void
}

// Джобы, выполняющиеся прямо сейчас: одна и та же джоба не должна идти в два
// потока, даже если её цикл случайно запустили дважды в одном процессе.
const running = new Set<string>()

export type JobRunResult = { ok: boolean; skipped?: boolean }

/** Один прогон с учётом в базе. Ошибка фиксируется, но не пробрасывается. */
export async function runJobOnce(def: JobDef): Promise<JobRunResult> {
  const log = def.log ?? console.log
  const logError = def.logError ?? console.error
  if (running.has(def.name)) {
    log(`[job:${def.name}] предыдущий прогон ещё идёт — пропускаю`)
    return { ok: false, skipped: true }
  }
  running.add(def.name)
  const started = Date.now()
  await writeState(def.name, 'lastStartedAt', new Date(started).toISOString())
  try {
    const summary = await def.run()
    const doneIso = new Date().toISOString()
    await writeState(def.name, 'lastCompletedAt', doneIso)
    await writeState(def.name, 'lastSuccessAt', doneIso)
    await writeState(def.name, 'lastError', '')
    log(
      `[job:${def.name}] готово за ${((Date.now() - started) / 1000).toFixed(1)}с` +
        (summary ? `: ${summary}` : ''),
    )
    return { ok: true }
  } catch (e: any) {
    const message = String(e?.message ?? e).slice(0, 500)
    await writeState(def.name, 'lastCompletedAt', new Date().toISOString())
    await writeState(def.name, 'lastError', message)
    logError(`[job:${def.name}] ошибка: ${message}`)
    return { ok: false }
  } finally {
    running.delete(def.name)
  }
}

/**
 * Запускает вечный цикл джобы. Не `setInterval`: после каждого прогона срок
 * пересчитывается от фактического lastSuccessAt из базы, поэтому рестарт не
 * съедает очередной запуск, а просроченный при старте выполняется сразу.
 * Неудачный прогон повторяется с растущей паузой (без tight loop).
 */
export function startJobLoop(def: JobDef): void {
  const log = def.log ?? console.log
  const bootDelay = def.bootDelayMs ?? JOB_BOOT_DELAY_MS
  let failures = 0

  const schedule = async () => {
    let delay = bootDelay
    try {
      const last = await readJobState(def.name, 'lastSuccessAt')
      delay =
        failures > 0
          ? jobRetryDelayMs(failures, def.periodMs)
          : nextJobDelayMs(last, Date.now(), def.periodMs, bootDelay)
    } catch (e: any) {
      ;(def.logError ?? console.error)(
        `[job:${def.name}] не смог прочитать состояние: ${e?.message ?? e}`,
      )
    }
    log(
      `[job:${def.name}] следующий прогон через ${Math.round(delay / 60_000)} мин` +
        (failures ? ` (попытка ${failures + 1})` : ''),
    )
    const timer = setTimeout(async () => {
      const r = await runJobOnce(def)
      // пропуск из-за уже идущего прогона (например, запуск после синка) — не ошибка
      failures = r.ok ? 0 : r.skipped ? failures : failures + 1
      void schedule()
    }, delay)
    timer.unref?.()
  }

  void schedule()
}
