import type { Book } from '../types'

/**
 * Закладка поверх обложки: «Книга на руках» и «Новинка» (рисунки заказчика,
 * `web/public/tag/*.webp`, вырезаны из исходных PNG в прозрачный webp).
 *
 * Показывается только на КРУПНОЙ обложке — в карточке книги и в центре
 * карусели. В списках обложка 44 пикселя шириной, и подпись на закладке там
 * превратилась бы в неразличимую полоску.
 *
 * Занятость важнее новизны: если книга и новая, и на руках, человеку в первую
 * очередь нужно знать, что взять её прямо сейчас не выйдет.
 */
export function BookTag({ book }: { book: Book }) {
  const kind = book.status === 'busy' ? 'onloan' : book.isNew ? 'new' : null
  if (!kind) return null
  const alt = kind === 'onloan' ? 'Книга на руках' : 'Новинка'
  return <img className="book-tag" src={`/tag/${kind}.webp`} alt={alt} loading="lazy" />
}
