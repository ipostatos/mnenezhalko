import type { FastifyInstance, FastifyRequest } from 'fastify'
import { prisma } from './db.js'
import { env } from './env.js'
import { upsertUser, verifyInitData, type TgUser } from './auth.js'
import { bookById, facets, searchBooks, toCard } from './search.js'
import { askAi, aiEnabled } from './ai.js'
import { CITIES } from './seed.js'
import { decodeDataUrl, readCover, saveCover } from './covers.js'
import { recognizePhoto, visionEnabled, LANGUAGES } from './vision.js'
import { looksLikeIsbn, lookupIsbnDetailed } from './isbn.js'
import {
  checkDuplicates,
  putOnShelf,
  editBook,
  softDeleteBook,
  resubmitBook,
  shelfState,
} from './publish.js'
import { digest } from './digest.js'
import {
  createLoan,
  decorate,
  listBorrowed,
  listLoans,
  listHistory,
  markReturned,
  reopenLoan,
  canUndoLoan,
  summarize,
} from './loans.js'
import { botUsername, createDonateLink, isDonateAmount } from './bot.js'
import { linkLibrarian } from './librarian.js'
import { notionWriteEnabled } from './notion-write.js'
import {
  ALLOWED_WIDTHS,
  CARD_W,
  CAROUSEL_W,
  LIST_W,
  cachedImage,
  imgPipelineMetrics,
  proxyCover,
  warmShowcaseCovers,
} from './imgcache.js'
import { isSafeCoverUrl } from './net.js'
import { redactCard, redactCards, redactEvent, redactMarketItem, redactOwner } from './privacy.js'

/** Достаёт пользователя из заголовка X-Init-Data, либо null. */
function who(req: FastifyRequest): TgUser | null {
  const raw = (req.headers['x-init-data'] as string) || ''
  return verifyInitData(raw)
}

/**
 * Можно ли показывать этому запросу контакты (см. privacy.ts). Каталог публичный,
 * контакты — только из Mini App с валидной подписью Telegram.
 */
const maySeeContacts = (req: FastifyRequest): boolean => who(req) !== null

const json = (v: unknown) =>
  JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)))

/**
 * `/api/loans` отдавал `book.coverUrl` сырой строкой прямо из базы — обложка
 * шла в обход всего конвейера (без ресайза, без кэша и, что важнее, без
 * SSRF-проверки в `net.ts`). Список выдач (`.loan-cover`, 54×78 CSS) — такой
 * же «список», как и остальные, поэтому пускаем через тот же прокси.
 */
function withCoverProxy<T extends { book?: { coverUrl: string | null } | null }>(loan: T): T {
  if (!loan.book) return loan
  return { ...loan, book: { ...loan.book, coverUrl: proxyCover(loan.book.coverUrl, LIST_W) } }
}

// Стабильная витрина карусели: подборка живёт 30 минут (memo по городу),
// чтобы не генерить новую случайную выборку на каждый заход.
const SHOWCASE_TTL = 30 * 60 * 1000
const SHOWCASE_LIMIT_DEFAULT = 12
const SHOWCASE_LIMIT_MAX = 16
const showcaseCache = new Map<string, { at: number; data: unknown }>()

/**
 * Счётчик обращений к платным ручкам (Claude): подбор книг и распознавание фото.
 * Экземпляр один, поэтому хватает памяти — внешнего хранилища заводить незачем.
 */
const HITS = new Map<string, number[]>()

/** @returns true, если лимит исчерпан и запрос надо отклонить. */
function tooOften(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const fresh = (HITS.get(key) ?? []).filter((t) => now - t < windowMs)
  // попутно чистим тех, кто давно не заходил, чтобы карта не росла бесконечно
  if (HITS.size > 5000) {
    for (const [k, times] of HITS) if (times.every((t) => now - t >= windowMs)) HITS.delete(k)
  }
  if (fresh.length >= limit) {
    HITS.set(key, fresh)
    return true
  }
  fresh.push(now)
  HITS.set(key, fresh)
  return false
}

export async function registerRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => {
    const [books, librarians, sync] = await Promise.all([
      prisma.book.count({ where: { active: true, reviewStatus: 'approved' } }),
      prisma.librarian.count(),
      prisma.syncState.findUnique({ where: { key: 'notion' } }),
    ])
    return {
      ok: true,
      books,
      librarians,
      lastSync: sync?.value ?? null,
      ai: aiEnabled(),
      vision: visionEnabled(),
      notionWrite: notionWriteEnabled(),
    }
  })

  app.post('/api/me', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const user = await upsertUser(u)
    // заодно привязываем импортированную из Notion запись по нику — полка подтянется
    const librarian = await linkLibrarian(
      { tgId: u.id, username: u.username, firstName: u.firstName },
      { allowCreate: false },
    )
    return json({ user, librarian })
  })

  app.patch('/api/me', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    await upsertUser(u)
    const { city } = req.body as { city?: string | null }
    const user = await prisma.user.update({
      where: { tgId: u.id },
      data: { city: city || null },
    })
    return json({ user })
  })

  app.get('/api/facets', async (req) => {
    const { city } = req.query as { city?: string }
    return facets(city || undefined)
  })

  app.get('/api/books', async (req) => {
    const q = req.query as Record<string, string>
    const found = await searchBooks({
      q: q.q,
      city: q.city,
      genre: q.genre,
      language: q.language,
      kind: q.kind === 'game' ? 'game' : q.kind === 'book' ? 'book' : undefined,
      ownerId: q.ownerId,
      limit: q.limit ? Number(q.limit) : 30,
      offset: q.offset ? Number(q.offset) : 0,
    })
    return { ...found, items: redactCards(found.items, maySeeContacts(req)) }
  })

  /**
   * Витрина для карусели: SHOWCASE_LIMIT_DEFAULT (12) одобренных книг с
   * обложкой, не больше SHOWCASE_LIMIT_MAX (16). Подборка стабильна 30 минут
   * (memo по городу+лимиту) — иначе каждый заход = новая случайная выборка,
   * новые сетевые запросы и декодирование.
   */
  app.get('/api/showcase', async (req, reply) => {
    const { city, limit: limitRaw } = req.query as { city?: string; limit?: string }
    const parsed = limitRaw ? Number(limitRaw) : NaN
    const limit = Number.isFinite(parsed) && parsed > 0
      ? Math.min(Math.round(parsed), SHOWCASE_LIMIT_MAX)
      : SHOWCASE_LIMIT_DEFAULT
    reply.header('Cache-Control', 'private, max-age=1800')
    const key = `${city || '*'}:${limit}`
    const hit = showcaseCache.get(key)
    if (hit && Date.now() - hit.at < SHOWCASE_TTL) return hit.data

    type Row = { id: string; title: string; coverUrl: string }
    const rows = city
      ? await prisma.$queryRaw<Row[]>`SELECT id, title, coverUrl FROM Book
          WHERE active = 1 AND reviewStatus = 'approved' AND coverUrl IS NOT NULL AND coverUrl <> ''
          AND city = ${city}
          ORDER BY RANDOM() LIMIT ${limit}`
      : await prisma.$queryRaw<Row[]>`SELECT id, title, coverUrl FROM Book
          WHERE active = 1 AND reviewStatus = 'approved' AND coverUrl IS NOT NULL AND coverUrl <> ''
          ORDER BY RANDOM() LIMIT ${limit}`
    // карусель показывает обложки на 156px — превью 320px (2× под retina) хватает
    const data = rows.map((r) => ({ ...r, coverUrl: proxyCover(r.coverUrl, CAROUSEL_W) }))
    showcaseCache.set(key, { at: Date.now(), data })
    // прогреваем превью новой ротации в фоне — первый посетитель не должен
    // оплачивать все MISS сразу; не блокирует ответ, не await'им
    warmShowcaseCovers(rows.map((r) => r.coverUrl))
    return data
  })

  /** Конвейер обложек (подписанный): ресайз в webp-превью нужной ширины + кэш. */
  app.get('/api/img', async (req, reply) => {
    const { u, s, w } = req.query as { u?: string; s?: string; w?: string }
    if (!u || !s) return reply.code(400).send({ error: 'bad_request' })
    // ширину не «подгоняем», а требуем ровно ту, что мы сами и подписываем:
    // прежний clamp превращал ссылку с чужой шириной в вечный 400 по подписи —
    // ошибку было видно только по битым картинкам у людей
    const width = Number(w)
    if (!ALLOWED_WIDTHS.includes(width)) {
      req.log.warn(`[img] ширина вне белого списка: ${w}`)
      return reply.code(400).send({ error: 'bad_width' })
    }
    let host = ''
    try {
      host = new URL(u).hostname
    } catch {
      /* невалидный url — подпись всё равно не сойдётся */
    }

    const t0 = Date.now()
    const img = await cachedImage(u, width, s)
    const dur = Date.now() - t0

    if (!img) {
      // не сошлась подпись/url — не наша обложка вовсе, не метрика кэша
      return reply.code(400).send({ error: 'bad_signature' })
    }

    // метрики для честного замера p50/p95: HIT — с диска, MISS — реально
    // спросили origin (успешно или нет), NEGATIVE — уже знаем, что не выйдет,
    // origin в этот раз не трогали вовсе (структурные логи — внутри cachedImage)
    reply.header('X-Image-Origin', host)
    reply.header('Server-Timing', `img;dur=${dur}`)
    reply.header('X-Image-Cache', img.cache)

    if (img.cache === 'NEGATIVE' || !('body' in img)) {
      return reply.code(404).send({ error: 'not_found' })
    }
    reply.header('Cache-Control', 'public, max-age=31536000, immutable')
    reply.type(img.type)
    return reply.send(img.body)
  })

  /** Метрики image pipeline (HIT/MISS/NEGATIVE, длительности, диск) — только админу. */
  app.get('/api/admin/img-metrics', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const user = await upsertUser(u)
    if (!user.isAdmin) return reply.code(403).send({ error: 'admin_only' })
    return imgPipelineMetrics()
  })

  app.get('/api/books/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const book = await bookById(id)
    if (!book) return reply.code(404).send({ error: 'not_found' })
    return redactCard(book, maySeeContacts(req))
  })

  app.get('/api/librarians/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const l = await prisma.librarian.findUnique({
      where: { id },
      include: {
        books: {
          where: { active: true, reviewStatus: 'approved' },
          orderBy: { title: 'asc' },
          take: 200,
        },
      },
    })
    if (!l) return reply.code(404).send({ error: 'not_found' })
    const { books, ...owner } = l
    const allowed = maySeeContacts(req)
    return json({
      owner: redactOwner(owner, allowed),
      books: redactCards(books.map((b) => toCard(b)), allowed),
    })
  })

  /**
   * Подбор книг ИИ. Ручка платная (два обращения к Claude на запрос), поэтому
   * только для своих — подпись Telegram обязательна — и с лимитом на человека.
   */
  app.post('/api/ai', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    if (tooOften(`ai:${u.id}`, 12, 60_000)) return reply.code(429).send({ error: 'too_many' })
    const { text, city } = req.body as { text?: string; city?: string }
    if (!text || text.trim().length < 2) return reply.code(400).send({ error: 'empty' })
    return askAi(text.trim().slice(0, 500), city || undefined)
  })

  /**
   * Счёт Telegram Stars для доната прямо в Mini App (openInvoice).
   * Только своим (подпись Telegram) и с лимитом — как у прочих пишущих ручек.
   */
  app.post('/api/donate/link', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    if (tooOften(`donate:${u.id}`, 20, 60_000)) return reply.code(429).send({ error: 'too_many' })
    const { amount } = req.body as { amount?: number }
    if (!isDonateAmount(amount)) return reply.code(400).send({ error: 'bad_amount' })
    try {
      return { link: await createDonateLink(amount) }
    } catch (e: any) {
      req.log.error(`донат: не удалось создать счёт: ${e?.message ?? e}`)
      return reply.code(502).send({ error: 'invoice_failed' })
    }
  })

  /* ── «у кого моя книга сейчас» ──────────────────────────── */

  app.get('/api/loans', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const [given, taken, history] = await Promise.all([
      listLoans(u.id, 'active'),
      listBorrowed(u.id),
      listHistory(u.id),
    ])
    return json({
      given: given.map(decorate).map(withCoverProxy),
      taken: taken.map(decorate).map(withCoverProxy),
      history: history.map((l) => ({
        ...withCoverProxy(l),
        role: l.ownerTg === u.id ? 'given' : 'taken',
        canUndo: canUndoLoan(l),
      })),
      summary: summarize(given.filter((l) => l.status === 'active')),
    })
  })

  /** Отменить возврат (undo) — в окне 24 ч, если книгу не выдали другому. */
  app.post('/api/loans/:id/reopen', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const { id } = req.params as { id: string }
    const r = await reopenLoan(id, u.id)
    if ('error' in r) {
      const code = r.error === 'not_found' ? 404 : r.error === 'forbidden' ? 403 : 409
      return reply.code(code).send({ error: r.error })
    }
    return json({ loan: r.loan })
  })

  /** Отметить, что книга ушла почитать: название + ник читателя. */
  app.post('/api/loans', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    await upsertUser(u)
    const b = req.body as Record<string, any>
    if (!b.title || !b.holder) return reply.code(400).send({ error: 'bad_request' })
    try {
      const loan = await createLoan({
        ownerTg: u.id,
        title: String(b.title),
        bookId: b.bookId ? String(b.bookId) : null,
        holder: String(b.holder),
        days: b.days === null ? null : b.days ? Number(b.days) : undefined,
        takenAt: b.takenAt ? String(b.takenAt) : null,
        note: b.note ? String(b.note) : null,
      })
      return json({
        loan,
        inviteUrl: loan.claimToken ? `https://t.me/${botUsername()}?start=loan_${loan.claimToken}` : null,
      })
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message ?? 'bad_request' })
    }
  })

  app.post('/api/loans/:id/return', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const { id } = req.params as { id: string }
    const loan = await markReturned(id, u.id)
    if (!loan) return reply.code(404).send({ error: 'not_found' })
    return json({ loan })
  })

  /** Мои книги на полке — из них удобно выбирать, что отдаёшь. */
  app.get('/api/my-books', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const librarian = await linkLibrarian(
      { tgId: u.id, username: u.username, firstName: u.firstName },
      { allowCreate: false },
    )
    if (!librarian) return json([])
    // для выдачи предлагаем только реальные книги на полке (одобренные, свободные)
    const books = await prisma.book.findMany({
      where: { ownerId: librarian.id, active: true, reviewStatus: 'approved' },
      orderBy: { title: 'asc' },
      take: 200,
    })
    return json(books.map((b) => toCard(b)))
  })

  /**
   * Моя полка целиком: со всеми состояниями (на полке, на проверке, отклонена,
   * на руках, ошибка синка, удалена) — для управления в Mini App.
   */
  app.get('/api/my-shelf', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const librarian = await linkLibrarian(
      { tgId: u.id, username: u.username, firstName: u.firstName },
      { allowCreate: false },
    )
    if (!librarian) return json({ books: [] })
    const rows = await prisma.book.findMany({
      where: { ownerId: librarian.id, OR: [{ active: true }, { reviewStatus: 'deleted' }] },
      orderBy: [{ createdAt: 'desc' }],
      take: 300,
    })
    // «Моя полка» рисует обложку и в списке (.cover, 44×62 CSS), и на экране правки
    // (.edit-cover, 128×180 CSS) — берём один размер CARD_W на оба, чтобы список
    // и правка тянули один и тот же файл из кэша, без второй загрузки
    return json({ books: rows.map((b) => ({ ...toCard(b, { w: CARD_W }), state: shelfState(b) })) })
  })

  /** Редактировать свою книгу. */
  app.patch('/api/books/:id', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const { id } = req.params as { id: string }
    const b = req.body as Record<string, any>
    const list = (v: unknown) =>
      Array.isArray(v) ? v.map(String) : undefined
    const r = await editBook(id, u.id, {
      title: b.title !== undefined ? String(b.title) : undefined,
      author: b.author !== undefined ? (b.author ? String(b.author) : null) : undefined,
      genres: list(b.genres),
      languages: list(b.languages),
      city: b.city !== undefined ? (b.city ? String(b.city) : null) : undefined,
      district: b.district !== undefined ? (b.district ? String(b.district) : null) : undefined,
    })
    if ('error' in r) {
      return reply.code(r.error === 'forbidden' ? 403 : 404).send({ error: r.error })
    }
    return json(r)
  })

  /** Мягко удалить свою книгу (на руках — можно скрыть после возврата). */
  app.post('/api/books/:id/delete', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const { id } = req.params as { id: string }
    const { hideAfterReturn } = req.body as { hideAfterReturn?: boolean }
    const r = await softDeleteBook(id, u.id, Boolean(hideAfterReturn))
    if ('error' in r) {
      const code = r.error === 'forbidden' ? 403 : r.error === 'has_active_loan' ? 409 : 404
      return reply.code(code).send({ error: r.error })
    }
    return json(r)
  })

  /** Повторно отправить отклонённую книгу на модерацию. */
  app.post('/api/books/:id/resubmit', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const { id } = req.params as { id: string }
    const r = await resubmitBook(id, u.id)
    if ('error' in r) {
      const code = r.error === 'forbidden' ? 403 : r.error === 'bad_state' ? 409 : 404
      return reply.code(code).send({ error: r.error })
    }
    return json(r)
  })

  /** Новинки библиотеки: `period=day|month`. */
  app.get('/api/digest', async (req) => {
    const { period, city } = req.query as { period?: string; city?: string }
    const d = await digest(period === 'month' ? 'month' : 'day', city || undefined)
    return json({ ...d, items: redactCards(d.items, maySeeContacts(req)) })
  })

  app.get('/api/cities', async () => {
    const counts = await prisma.book.groupBy({
      by: ['city'],
      _count: true,
      where: { active: true, reviewStatus: 'approved' },
    })
    const byCity = new Map(counts.map((c) => [c.city ?? '', c._count]))
    const groups = await prisma.cityGroup.findMany({ orderBy: [{ city: 'asc' }, { sort: 'asc' }] })
    return CITIES.map((city) => ({
      city,
      books: byCity.get(city) ?? 0,
      groups: groups.filter((g) => g.city === city),
    })).sort((a, b) => b.books - a.books)
  })

  app.get('/api/groups', async (req) => {
    const { city } = req.query as { city?: string }
    const where = city ? { OR: [{ city }, { city: 'Все города' }] } : {}
    return prisma.cityGroup.findMany({ where, orderBy: [{ sort: 'asc' }, { city: 'asc' }] })
  })

  app.get('/api/events', async (req) => {
    const { city } = req.query as { city?: string }
    const events = await prisma.event.findMany({
      where: {
        startsAt: { gte: new Date(Date.now() - 6 * 3600_000) },
        ...(city ? { city } : {}),
      },
      orderBy: { startsAt: 'asc' },
      take: 50,
    })
    // createdBy — числовой tgId админа, клиенту не нужен (см. privacy.ts)
    return json(events.map(redactEvent))
  })

  app.post('/api/events', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const user = await upsertUser(u)
    if (!user.isAdmin) return reply.code(403).send({ error: 'admin_only' })
    const b = req.body as Record<string, string>
    if (!b.city || !b.title || !b.startsAt) return reply.code(400).send({ error: 'bad_request' })
    const ev = await prisma.event.create({
      data: {
        city: b.city,
        title: b.title.slice(0, 200),
        startsAt: new Date(b.startsAt),
        place: b.place?.slice(0, 200) || null,
        description: b.description?.slice(0, 1000) || null,
        url: b.url?.slice(0, 500) || null,
        createdBy: u.id,
      },
    })
    return json(ev)
  })

  app.get('/api/market', async (req) => {
    const { city } = req.query as { city?: string }
    const items = await prisma.marketItem.findMany({
      where: { status: 'active', ...(city ? { city } : {}) },
      orderBy: { bumpedAt: 'desc' },
      take: 60,
    })
    // раньше отдавались сырые строки: числовой authorTg + ник всех, кто писал
    // в барахолку, без всякой авторизации (см. privacy.ts)
    const allowed = maySeeContacts(req)
    return json(items.map((i) => redactMarketItem(i, allowed)))
  })

  /** Фото обложки → предзаполненная карточка + сохранённая обложка. */
  app.post('/api/recognize', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    // распознавание тоже идёт в Claude, и картинка весит мегабайты
    if (tooOften(`vision:${u.id}`, 20, 300_000)) return reply.code(429).send({ error: 'too_many' })
    const { image } = req.body as { image?: string }
    if (!image) return reply.code(400).send({ error: 'bad_request' })

    let decoded
    try {
      decoded = decodeDataUrl(image)
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message ?? 'bad_image' })
    }

    const [saved, photo] = await Promise.all([
      saveCover(decoded),
      recognizePhoto(decoded.data, decoded.mediaType).catch((e) => {
        req.log.warn(`распознавание не удалось: ${e?.message ?? e}`)
        return null
      }),
    ])

    // мастер добавления ведёт по одной книге; если на фото их несколько
    // (стопка, полка корешками), остальные отдаём подсказкой — см. AddBook.tsx
    const first = photo?.books[0] ?? null
    const recognized = first
      ? { ...first, note: photo?.note ?? null }
      : photo
        ? {
            recognized: false,
            kind: 'book' as const,
            title: '',
            author: null,
            languages: [],
            genres: [],
            confidence: 'low' as const,
            note: photo.note,
          }
        : null
    const extraBooks = (photo?.books ?? []).slice(1).map((b) => ({ title: b.title, author: b.author }))

    const dup = recognized?.title
      ? await checkDuplicates({
          title: recognized.title,
          author: recognized.author,
          kind: recognized.kind === 'game' ? 'game' : 'book',
          ownerTg: u.id,
        })
      : { own: null, others: { count: 0, city: null, byCity: [], unknownCity: 0, where: '' } }

    return json({ cover: saved.url, recognized, dup, extraBooks, languages: LANGUAGES })
  })

  app.get('/api/cover/:file', async (req, reply) => {
    const { file } = req.params as { file: string }
    const found = await readCover(file)
    if (!found) return reply.code(404).send({ error: 'not_found' })
    reply.header('Cache-Control', 'public, max-age=31536000, immutable')
    reply.type(found.type)
    return reply.send(found.body)
  })

  /**
   * Проверка дублей до сохранения: свой повтор (предупреждаем) vs чужие
   * экземпляры (подсказка). Подпись Telegram нужна, чтобы отличить «свою» книгу.
   */
  app.get('/api/duplicates', async (req) => {
    const u = who(req)
    const { title, author, kind } = req.query as { title?: string; author?: string; kind?: string }
    return json(
      await checkDuplicates({
        title: title || '',
        author,
        kind: kind === 'game' ? 'game' : 'book',
        ownerTg: u?.id ?? null,
      }),
    )
  })

  /**
   * Книга по ISBN для мастера добавления. Подпись Telegram + лимит: ручка ходит
   * во внешние каталоги, открытым прокси к ним быть не должна.
   */
  app.get('/api/isbn', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    if (tooOften(`isbn:${u.id}`, 30, 300_000)) return reply.code(429).send({ error: 'too_many' })
    const { code } = req.query as { code?: string }
    if (!code || !looksLikeIsbn(code)) return reply.code(400).send({ error: 'bad_isbn' })
    const r = await lookupIsbnDetailed(code).catch((e) => {
      req.log.warn(`поиск по ISBN не удался: ${e?.message ?? e}`)
      return null
    })
    return json(r ?? { book: null, notFound: true, quotaBlocked: false })
  })

  /**
   * Поставить книгу на полку: карточка у нас + строка в общей таблице Notion
   * (Owners заводится автоматически, настолки уходят в Board Games).
   */
  app.post('/api/books', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const user = await upsertUser(u)
    const b = req.body as Record<string, any>
    if (!b.title || String(b.title).trim().length < 2) {
      return reply.code(400).send({ error: 'bad_request' })
    }

    // город может прийти как «Warszawa/Wola» либо отдельным полем district
    const [city, districtFromCity] = String(b.city || '').split('/').map((s: string) => s.trim())
    const list = (v: unknown) =>
      Array.isArray(v)
        ? v.map(String)
        : String(v || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)

    let coverUrl: string | null = b.coverUrl ? String(b.coverUrl) : null
    // coverUrl от пользователя нельзя брать на веру — иначе через него можно
    // заставить сервер сходить внутрь сети (SSRF). Внешний http(s) — только на
    // публичный хост; свой относительный /api/cover сюда не попадает.
    if (coverUrl && /^https?:\/\//i.test(coverUrl) && !isSafeCoverUrl(coverUrl)) {
      return reply.code(400).send({ error: 'bad_cover_url' })
    }
    if (!coverUrl && b.coverImage) {
      try {
        coverUrl = (await saveCover(decodeDataUrl(String(b.coverImage)))).url
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message ?? 'bad_image' })
      }
    }

    const res = await putOnShelf({
      tgId: u.id,
      username: u.username ?? null,
      firstName: user.firstName ?? u.firstName ?? null,
      kind: b.kind === 'game' ? 'game' : 'book',
      title: String(b.title),
      author: b.author ? String(b.author) : null,
      genres: list(b.genres),
      languages: list(b.languages),
      city: city || user.city || null,
      district: (b.district ? String(b.district) : districtFromCity) || null,
      coverUrl,
    })
    return json(res)
  })

  /** Прокси картинок из Telegram (file_id → байты), чтобы Mini App их видел. */
  app.get('/api/photo/:fileId', async (req, reply) => {
    const { fileId } = req.params as { fileId: string }
    const meta = (await (
      await fetch(`https://api.telegram.org/bot${env.botToken}/getFile?file_id=${fileId}`)
    ).json()) as { ok: boolean; result?: { file_path: string } }
    if (!meta.ok || !meta.result) return reply.code(404).send({ error: 'not_found' })
    const file = await fetch(
      `https://api.telegram.org/file/bot${env.botToken}/${meta.result.file_path}`,
    )
    reply.header('Cache-Control', 'public, max-age=86400')
    reply.type(file.headers.get('content-type') || 'image/jpeg')
    return reply.send(Buffer.from(await file.arrayBuffer()))
  })
}
