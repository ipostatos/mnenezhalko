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
  owner: Owner | null
  why?: string
}

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

export type RecognizeResult = {
  cover: string
  recognized: Recognized | null
  duplicates: Book[]
  languages: string[]
}

export type ShelfResult = {
  book: Book
  notionStatus: string
  notionError: string | null
}
