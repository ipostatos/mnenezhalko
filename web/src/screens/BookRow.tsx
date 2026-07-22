import type { Book } from '../types'
import { haptic } from '../telegram'

/** Строка книги: обложка, название, автор, жанры и город. */
export function BookRow({ book, onOpen }: { book: Book; onOpen: () => void }) {
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
          <img src={book.coverUrl} alt="" loading="lazy" onError={hideImage} />
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
}

function hideImage(e: React.SyntheticEvent<HTMLImageElement>) {
  e.currentTarget.style.display = 'none'
}
