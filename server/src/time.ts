/**
 * Локальное время проекта — Europe/Warsaw, БЕЗ захардкоженного смещения.
 *
 * Раньше афиши собирались как `${date}T${time}:00+02:00`: летом (CEST) это
 * верно, но с конца октября Польша живёт в +01:00 (CET) — все зимние встречи
 * съезжали бы на час. Библиотека дат не нужна: смещение на конкретный момент
 * честно отдаёт Intl с базой таймзон Node.
 */
const TZ = 'Europe/Warsaw'

const dtf = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

/** Смещение Варшавы (мс) в данный момент времени: +2ч летом, +1ч зимой. */
export function warsawOffsetMs(at: Date): number {
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]))
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second)
  return asUtc - at.getTime()
}

/**
 * «2026-08-01» + «18:30» по варшавским часам → точный момент времени (Date).
 *
 * Переходы на летнее/зимнее время: несуществующее локальное время (весенний
 * скачок 02:00→03:00) сдвигается на час вперёд, неоднозначное (осенний повтор
 * 02:xx) детерминированно берёт одно из двух смещений — для вечерних встреч
 * книжного клуба и то и другое за пределами практики, но не даёт NaN и сдвигов.
 */
export function warsawTime(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  if (![y, m, d, hh, mm].every(Number.isFinite)) return new Date(NaN)
  const utcGuess = Date.UTC(y, m - 1, d, hh, mm)
  // первая итерация даёт смещение «примерно в тот момент», вторая уточняет
  // на границах перехода — классическая двухшаговая схема без библиотек
  let ts = utcGuess - warsawOffsetMs(new Date(utcGuess))
  ts = utcGuess - warsawOffsetMs(new Date(ts))
  return new Date(ts)
}

/** Календарный день в Варшаве для произвольного момента: «2026-08-01». */
export function warsawDay(at = new Date()): string {
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}
