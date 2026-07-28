/**
 * Календарный день проекта — по варшавским часам, не по UTC.
 * `toISOString().slice(0, 10)` давал UTC-день: ночью по польскому времени
 * «сегодня» в форме выдачи уезжал на вчера, а максимум date-инпута не давал
 * выбрать текущий день. en-CA форматирует сразу как YYYY-MM-DD.
 */
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export const warsawDay = (at: Date = new Date()): string => dayFmt.format(at)
