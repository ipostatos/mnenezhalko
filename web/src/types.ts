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
  /** та же обложка в 320px — для найденной поиском книги в центре карусели */
  coverUrl320?: string | null
  status: string
  source: string
  /** состояние модерации: pending | approved | rejected | deleted */
  reviewStatus?: string
  rejectionReason?: string | null
  owner: Owner | null
  why?: string
  /** оценка произведения; null — книгу ещё никто не оценил */
  rating?: Rating | null
  /** очередь на занятую книгу; приходит только в карточке одной книги */
  waiting?: Waitlist
  /** книга появилась в проекте на днях — на обложке висит значок «Новинка» */
  isNew?: boolean
}

/** Средняя оценка книги и сколько людей её поставили. */
export type Rating = { avg: number | null; count: number }

/** Публичный отзыв: имя автора, без ника и без числового id (см. privacy.ts). */
export type Review = {
  id: string
  rating: number
  text: string | null
  authorName: string
  mine: boolean
  createdAt: string
}

export type ReviewsPayload = {
  rating: Rating
  items: Review[]
  /** запрос пришёл из Mini App с подписью Telegram (жалоба требует её) */
  signed: boolean
  /** право оценить есть только у того, кто книгу читал */
  canReview: boolean
  myReview: Review | null
  textMax: number
}

/** Книга на моей полке с вычисленным состоянием. */
export type ShelfState = 'active' | 'pending' | 'rejected' | 'onloan' | 'deleted' | 'syncerror'
export type ShelfBook = Book & {
  state: ShelfState
  /** сколько человек ждёт эту книгу — владельцу видно только число (issue #10) */
  waitCount?: number
}

/**
 * Очередь на занятую книгу: сколько всего ждут и где в ней я.
 * Соседей по очереди не видно — ни имён, ни ников (см. server/src/waitlist.ts).
 */
export type Waitlist = {
  count: number
  mine: { position: number; status: string; readyAt?: string | null } | null
}

export type Facets = {
  total: number
  genres: { value: string; count: number }[]
  languages: { value: string; count: number }[]
  cities: { value: string; count: number }[]
  /**
   * Справочник проекта из Notion: из него (и только из него) выбираются жанр и
   * язык в формах. Отличается от `genres`/`languages` выше — те показывают, что
   * фактически стоит у книг каталога, вместе со старыми значениями.
   */
  genreOptions?: string[]
  languageOptions?: string[]
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
  /** число городов проекта — из справочника сервера, не хардкод */
  cities?: number
  lastSync: string | null
  ai: boolean
  vision: boolean
  notionWrite: boolean
  /** страница книжного клуба «Книжная Клумба» (задаётся на сервере в CLUB_URL) */
  clubUrl?: string
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
  others: {
    count: number
    city: string | null
    byCity: { city: string; count: number }[]
    unknownCity: number
    /** готовая фраза «2 в Варшаве, 1 в Кракове» — считает сервер, одна на бота и Mini App */
    where: string
  }
}

/** Ответ поиска по ISBN: книга либо причина, почему её нет. */
export type IsbnLookup = {
  book: { title: string; author: string | null; coverUrl: string | null; source: string } | null
  notFound: boolean
  /** Google Books ответил 429 — русские издания без ключа почти не находятся */
  quotaBlocked: boolean
  /** каталог отвечал ошибкой сервера даже после повторов — стоит попробовать снова */
  serviceDown: boolean
}

export type RecognizeResult = {
  cover: string
  recognized: Recognized | null
  dup: DupCheck
  /** остальные книги, найденные на том же фото (мастер ведёт по одной) */
  extraBooks: { title: string; author: string | null }[]
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

/** Значок библиотекаря: заработанный или с прогрессом (issue #11). */
export type Badge = {
  id: string
  title: string
  hint: string
  emoji: string
  earned: boolean
  current: number
  target: number
}

/** «Сколько мы сберегли вместе» — оценка по числу обменов (issue #13). */
export type Impact = {
  exchanges: number
  moneyPln: number
  paperKg: number
  trees: number
  basis: { pricePln: number; paperPerBookKg: number; paperPerTreeKg: number }
}

/** Подсказка человека при вводе ника: только имя и ник, без tgId. */
export type Person = {
  name: string
  telegram: string
  source: 'history' | 'librarian'
}

/**
 * Что исчезнет при удалении данных (или уже исчезло). Ключи по-русски: их
 * показывают человеку как есть, см. server/src/mydata.ts.
 */
export type DeletionPreview = {
  summary: Record<string, number>
  /** последствия человеческим языком: числа сами по себе вводят в заблуждение */
  effects: string[]
}

/** Отказ удалить данные: сначала надо закрыть выдачи. */
export type DeletionBlocked = {
  error: 'active_loans'
  loans: { title: string; role: string }[]
}
