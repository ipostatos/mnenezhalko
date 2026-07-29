/**
 * Русское склонение по числу: «1 книга / 2 книги / 5 книг».
 * Одно место на всё приложение — раньше эта функция лежала копиями по экранам.
 */
export function plural(n: number, forms: [string, string, string]): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return forms[0]
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return forms[1]
  return forms[2]
}
