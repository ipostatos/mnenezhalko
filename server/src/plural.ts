/**
 * Русское склонение по числу: plural(n, ['книга', 'книги', 'книг']).
 * Одно место на весь сервер — раньше функция лежала копией в боте.
 */
export function plural(n: number, forms: [string, string, string]): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return forms[0]
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return forms[1]
  return forms[2]
}
