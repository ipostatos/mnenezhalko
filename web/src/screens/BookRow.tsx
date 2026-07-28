import { memo } from 'react'
import type { Book } from '../types'
import { haptic } from '../telegram'

/**
 * Строка книги: обложка, название, автор, жанры и город.
 * memo: каждый символ поиска перерисовывал все 40+ карточек списка.
 */
export const BookRow = memo(function BookRow({ book, onOpen }: { book: Book; onOpen: () => void }) {
  const initials = book.title.slice(0, 1).toUpperCase()
  const meta = [book.author, book.city && (book.district ? `${book.city} / ${book.district}` : book.city)]
    .filter(Boolean)
    .join(' · ')
  return (
    <button
      className="row-card"
      onClick={() => {
        haptic()
        onOpen()
      }}
    >
      <div className="cover">
        {book.coverUrl ? (
          <img src={book.coverUrl} alt="" loading="lazy" decoding="async" onError={hideImage} />
        ) : (
          <span>{initials}</span>
        )}
      </div>
      <div className="grow">
        <div className="t-sm">{book.title}</div>
        <div className="d">{meta || 'Книга проекта'}</div>
        {book.why && <div className="why">✨ {book.why}</div>}
      </div>
      <div className="chev">›</div>
    </button>
  )
},
// onOpen — свежая стрелка на каждый рендер, но ведёт себя одинаково для той же
// книги (замыкает только id и стабильный go) — сравниваем только book
(prev, next) => prev.book === next.book)

function hideImage(e: React.SyntheticEvent<HTMLImageElement>) {
  e.currentTarget.style.display = 'none'
}
