import { tg } from './telegram'
import type {
  BookClub,
  Book,
  CityInfo,
  EventItem,
  Facets,
  Health,
  MarketItem,
  Me,
  Owner,
  RecognizeResult,
  DupCheck,
  ShelfResult,
  DigestResult,
  Loan,
  LoanSummary,
  HistoryLoan,
  ShelfBook,
  IsbnLookup,
  Rating,
  Review,
  ReviewsPayload,
  Waitlist,
  Badge,
  Impact,
  Person,
  LibrarianPick,
  DeletionPreview,
  ModerationQueue,
} from './types'

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const initData: string = tg?.initData ?? ''
  if (initData) headers['X-Init-Data'] = initData

  const res = await fetch(path, {
    method,
    headers,
    // Mini App живёт в вебвью Telegram — без этого он может отдать устаревший ответ
    cache: 'no-store',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const data = await res.json()
      if (data?.error) message = data.error
    } catch {}
    throw new Error(message)
  }
  return res.json()
}

const qs = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v))
  const str = s.toString()
  return str ? `?${str}` : ''
}

export const api = {
  health: () => req<Health>('GET', '/api/health'),
  me: () => req<Me>('POST', '/api/me', {}),
  setCity: (city: string | null) => req<{ user: Me['user'] }>('PATCH', '/api/me', { city }),
  facets: (city?: string) => req<Facets>('GET', `/api/facets${qs({ city })}`),
  books: (p: {
    q?: string
    city?: string
    genre?: string
    language?: string
    kind?: string
    ownerId?: string
    limit?: number
    offset?: number
  }) => req<{ total: number; items: Book[] }>('GET', `/api/books${qs(p)}`),
  book: (id: string) => req<Book>('GET', `/api/books/${id}`),
  showcase: (city?: string) =>
    req<{ id: string; title: string; coverUrl: string }[]>('GET', `/api/showcase${qs({ city })}`),
  librarian: (id: string) =>
    req<{ owner: Owner; books: Book[] }>('GET', `/api/librarians/${id}`),
  ai: (text: string, city?: string) =>
    req<{ intro: string; items: Book[]; usedAi: boolean }>('POST', '/api/ai', { text, city }),
  loans: () =>
    req<{ given: Loan[]; taken: Loan[]; history: HistoryLoan[]; summary: LoanSummary }>(
      'GET',
      '/api/loans',
    ),
  loanReopen: (id: string) => req<{ loan: Loan }>('POST', `/api/loans/${id}/reopen`, {}),
  lend: (data: {
    title: string
    holder: string
    bookId?: string
    days?: number | null
    takenAt?: string
  }) =>
    req<{ loan: Loan; inviteUrl: string | null }>('POST', '/api/loans', data),
  loanReturn: (id: string) => req<{ loan: Loan }>('POST', `/api/loans/${id}/return`, {}),
  myBooks: () => req<Book[]>('GET', '/api/my-books'),
  myShelf: () => req<{ books: ShelfBook[] }>('GET', '/api/my-shelf'),

  /* «Мои данные»: выгрузка и удаление (см. server/src/mydata.ts) */
  exportMyData: () => req<Record<string, unknown>>('GET', '/api/me/export'),
  sendMyData: () => req<{ ok: true }>('POST', '/api/me/export/send', {}),
  deletePreview: () => req<DeletionPreview>('GET', '/api/me/delete-preview'),
  deleteMyData: () => req<DeletionPreview>('POST', '/api/me/delete-request', { confirm: 'УДАЛИТЬ' }),

  editBook: (
    id: string,
    data: {
      title?: string
      author?: string | null
      genres?: string[]
      languages?: string[]
      city?: string | null
      district?: string | null
    },
  ) => req<{ card: Book }>('PATCH', `/api/books/${id}`, data),
  deleteBook: (id: string, hideAfterReturn?: boolean) =>
    req<{ card?: Book; deferred?: boolean }>('POST', `/api/books/${id}/delete`, { hideAfterReturn }),
  resubmitBook: (id: string) =>
    req<{ card: Book; pending: boolean }>('POST', `/api/books/${id}/resubmit`, {}),
  digest: (period: 'day' | 'month', city?: string) =>
    req<DigestResult>('GET', `/api/digest${qs({ period, city })}`),
  cities: () => req<CityInfo[]>('GET', '/api/cities'),
  events: (city?: string) => req<EventItem[]>('GET', `/api/events${qs({ city })}`),
  /** Прошедшие встречи — только админу, для блока уборки на экране «Встречи». */
  pastEvents: (city?: string) => req<EventItem[]>('GET', `/api/admin/events/past${qs({ city })}`),
  removeEvent: (id: string) =>
    req<{ ok: true; id: string }>('POST', `/api/admin/events/${id}/remove`, {}),
  market: (city?: string) => req<MarketItem[]>('GET', `/api/market${qs({ city })}`),
  /** Книжные клубы проекта (в городе их может быть несколько). */
  clubs: () => req<BookClub[]>('GET', '/api/clubs'),
  addBook: (data: {
    title: string
    author?: string
    genres?: string
    languages?: string
    city?: string
    district?: string
    kind?: string
    coverUrl?: string
    coverImage?: string
    /** админ ставит книгу на полку этого библиотекаря, а не на свою */
    ownerLibrarianId?: string
  }) => req<ShelfResult>('POST', '/api/books', data),
  /** Поиск библиотекаря, за которого админ вносит книгу. */
  adminLibrarians: (q: string) =>
    req<{ librarians: LibrarianPick[] }>('GET', `/api/admin/librarians${qs({ q })}`),
  /** Фото обложки (dataURL) → распознанные поля, сохранённая обложка и дубли. */
  recognize: (image: string) => req<RecognizeResult>('POST', '/api/recognize', { image }),
  duplicates: (title: string, author?: string, kind?: string, ownerLibrarianId?: string) =>
    req<DupCheck>('GET', `/api/duplicates${qs({ title, author, kind, ownerLibrarianId })}`),
  /** Книга по ISBN из открытых каталогов (OpenLibrary, Biblioteka Narodowa, Google Books). */
  isbn: (code: string) => req<IsbnLookup>('GET', `/api/isbn${qs({ code })}`),
  /** Ссылка на счёт Telegram Stars для доната прямо в Mini App. */
  donateLink: (amount: number) => req<{ link: string }>('POST', '/api/donate/link', { amount }),
  /** Оценки и аннотации к книге; canReview приходит только для читавших. */
  reviews: (bookId: string) => req<ReviewsPayload>('GET', `/api/books/${bookId}/reviews`),
  saveReview: (bookId: string, data: { rating: number; text: string | null }) =>
    req<{ rating: Rating; items: Review[] }>('POST', `/api/books/${bookId}/review`, data),
  deleteReview: (bookId: string) =>
    req<{ rating: Rating; items: Review[] }>('DELETE', `/api/books/${bookId}/review`),
  reportReview: (id: string) =>
    req<{ hidden: boolean; reports: number }>('POST', `/api/reviews/${id}/report`, {}),
  /** Встать в очередь на занятую книгу: «сообщите, когда освободится». */
  wait: (bookId: string) =>
    req<{ waiting: Waitlist }>('POST', `/api/books/${bookId}/wait`, {}),
  /** Уйти из очереди. */
  unwait: (bookId: string) => req<{ waiting: Waitlist }>('DELETE', `/api/books/${bookId}/wait`),
  /** Сколько проект сберёг вместе: агрегат, без единого человека внутри. */
  impact: () => req<Impact>('GET', '/api/impact'),
  /** Свои значки библиотекаря — только про себя (issue #11). */
  badges: () => req<{ badges: Badge[] }>('GET', '/api/my-badges'),
  /** Кого предложить при вводе ника: библиотекари и свои прошлые читатели. */
  people: (q: string) => req<{ people: Person[] }>('GET', `/api/people${qs({ q })}`),

  /* Разбор для админов. Все ручки закрыты подписью И проверкой прав на сервере:
     спрятанная в приложении кнопка защитой не считается (см. moderation.ts). */
  moderationQueue: () => req<ModerationQueue>('GET', '/api/admin/moderation'),
  decideBook: (id: string, decision: 'approve' | 'reject', reason?: string) =>
    req<{ ok: true; already?: boolean; card: Book }>(
      'POST',
      `/api/admin/books/${id}/decide`,
      { decision, reason },
    ),
  decideReview: (id: string, decision: 'hide' | 'restore' | 'delete' | 'dismiss', reason?: string) =>
    req<{ ok: true; action: string; notice: string }>(
      'POST',
      `/api/admin/reviews/${id}/decide`,
      { decision, reason },
    ),
  restrictUser: (tgId: string, scope: string, reason: string, days?: number | null) =>
    req<{ ok: true }>('POST', `/api/admin/users/${tgId}/restrict`, { scope, reason, days }),
  unrestrictUser: (tgId: string, scope: string, reason: string) =>
    req<{ ok: true }>('POST', `/api/admin/users/${tgId}/unrestrict`, { scope, reason }),
  banUser: (tgId: string, reason: string) =>
    req<{ ok: true }>('POST', `/api/admin/users/${tgId}/ban`, { reason }),
  unbanUser: (tgId: string, reason: string) =>
    req<{ ok: true }>('POST', `/api/admin/users/${tgId}/unban`, { reason }),
}
