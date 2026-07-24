export type Owner = {
  id: string
  name: string
  telegram: string | null
  instagram: string | null
  city: string | null
  district: string | null
}

export type Book = {
  id: string
  kind: string
  title: string
  author: string | null
  genres: string[]
  languages: string[]
  city: string | null
  district: string | null
  coverUrl: string | null
  status: string
  source: string
  /** состояние модерации: pending | approved | rejected | deleted */
  reviewStatus?: string
  rejectionReason?: string | null
  owner: Owner | null
  why?: string
}

/** Книга на моей полке с вычисленным состоянием. */
export type ShelfState = 'active' | 'pending' | 'rejected' | 'onloan' | 'deleted' | 'syncerror'
export type ShelfBook = Book & { state: ShelfState }

export type Facets = {
  total: number
  genres: { value: string; count: number }[]
  languages: { value: string; count: number }[]
  cities: { value: string; count: number }[]
}

export type CityGroup = {
  id: number
  city: string
  title: string
  url: string
  kind: string
}

export type CityInfo = {
  city: string
  books: number
  groups: CityGroup[]
}

export type EventItem = {
  id: string
  city: string
  title: string
  startsAt: string
  place: string | null
  description: string | null
  url: string | null
}

export type MarketItem = {
  id: string
  city: string
  kind: string
  title: string
  description: string | null
  price: string | null
  photo: string | null
  authorUsername: string | null
  createdAt: string
}

export type Me = {
  user: { tgId: string; username: string | null; firstName: string | null; city: string | null; isAdmin: boolean }
  librarian: { id: string; name: string; city: string | null } | null
}

export type Health = {
  ok: boolean
  books: number
  librarians: number
  lastSync: string | null
  ai: boolean
  vision: boolean
  notionWrite: boolean
}

/** Ответ распознавания обложки по фото. */
export type Recognized = {
  recognized: boolean
  kind: 'book' | 'game'
  title: string
  author: string | null
  languages: string[]
  genres: string[]
  confidence: 'high' | 'medium' | 'low'
  note: string | null
}

/** Проверка дублей: свой повтор (предупреждение) vs чужие экземпляры (подсказка). */
export type DupCheck = {
  own: Book | null
  others: { count: number; city: string | null }
}

export type RecognizeResult = {
  cover: string
  recognized: Recognized | null
  dup: DupCheck
  languages: string[]
}

/** Настроение выдачи: чем дольше книга у читателя, тем грустнее. */
export type Mood = {
  level: 0 | 1 | 2 | 3 | 4
  emoji: string
  label: string
  days: number
  overdueDays: number
}

export type LoanSummary = {
  active: number
  overdue: number
  longestDays: number
  longestTitle: string | null
  mood: Mood | null
}

/** Выдача книги из рук в руки. */
export type Loan = {
  mood: Mood
  id: string
  title: string
  bookId: string | null
  book: { id: string; title: string; coverUrl: string | null } | null
  holderUsername: string | null
  holderName: string | null
  status: string
  takenAt: string
  dueAt: string | null
  returnedAt: string | null
}

/** Закрытая выдача для вкладки «История». */
export type HistoryLoan = {
  id: string
  title: string
  book: { id: string; title: string; coverUrl: string | null } | null
  holderUsername: string | null
  holderName: string | null
  takenAt: string
  returnedAt: string | null
  role: 'given' | 'taken'
  canUndo: boolean
}

export type DigestResult = {
  period: 'day' | 'month'
  since: string
  total: number
  items: Book[]
  byCity: { city: string; count: number }[]
}

export type ShelfResult = {
  book: Book
  notionStatus: string
  notionError: string | null
}
