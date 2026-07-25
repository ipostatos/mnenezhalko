/**
 * Поиск книги по ISBN — для пакетного добавления списком ISBN.
 * Сначала OpenLibrary (надёжен, отдаёт авторов именами), затем Google Books
 * запасным (без ключа часто отдаёт 429 даже с прод-IP). Ключи не нужны.
 */
export type IsbnBook = { title: string; author: string | null; coverUrl: string | null }

const onlyIsbn = (s: string) => s.replace(/[^0-9Xx]/g, '').toUpperCase()

/** Похоже ли на ISBN-10/13 (после выкидывания дефисов/пробелов). */
export function looksLikeIsbn(s: string): boolean {
  const d = onlyIsbn(s)
  return (d.length === 10 || d.length === 13) && /^\d{9}[\dX]$|^\d{13}$/.test(d)
}

export async function lookupIsbn(raw: string): Promise<IsbnBook | null> {
  const isbn = onlyIsbn(raw)
  if (isbn.length !== 10 && isbn.length !== 13) return null

  // OpenLibrary Books API — надёжный источник: название, авторов (именами) и обложку разом.
  // Первым, потому что Google Books без ключа отдаёт 429 (rate limit) даже с прод-IP.
  try {
    const r = await fetch(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`,
    )
    if (r.ok) {
      const j = (await r.json()) as any
      const b = j[`ISBN:${isbn}`]
      if (b?.title) {
        const authors: string[] = Array.isArray(b.authors)
          ? b.authors.map((a: any) => a?.name).filter(Boolean)
          : []
        return {
          title: String(b.title).slice(0, 300),
          author: authors.length ? authors.join(', ').slice(0, 200) : null,
          coverUrl:
            b.cover?.large ||
            b.cover?.medium ||
            `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`,
        }
      }
    }
  } catch {
    /* пробуем Google Books */
  }

  // Google Books — запасной (шире по русским изданиям, если не упрётся в 429)
  try {
    const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`)
    if (r.ok) {
      const j = (await r.json()) as any
      const v = j.items?.[0]?.volumeInfo
      if (v?.title) {
        const cover: string | undefined = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail
        return {
          title: String(v.title).slice(0, 300),
          author: Array.isArray(v.authors) && v.authors.length ? v.authors.join(', ') : null,
          coverUrl: cover ? cover.replace(/^http:/, 'https:') : null,
        }
      }
    }
  } catch {
    /* не нашли */
  }
  return null
}
