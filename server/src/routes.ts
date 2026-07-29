import type { FastifyInstance, FastifyRequest } from 'fastify'
import { prisma } from './db.js'
import { env } from './env.js'
import { upsertUser, verifyInitData, type TgUser } from './auth.js'
import { bookById, facets, searchBooks, toCard } from './search.js'
import { askAi, aiEnabled } from './ai.js'
import { CITIES } from './seed.js'
import { decodeDataUrl, readCover, readCoverVariant, saveCover } from './covers.js'
import { recognizePhoto, visionEnabled } from './vision.js'
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
import { getTaxonomy } from './taxonomy.js'
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
import {
  askForRating,
  botUsername,
  createDonateLink,
  flushWaitlistNotices,
  isDonateAmount,
} from './bot.js'
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
import { fetchWithTimeout, isSafeCoverUrl, readBodyLimited } from './net.js'
import {
  REVIEW_TEXT_MAX,
  canReview,
  deleteReview,
  listReviews,
  ratingFor,
  reportReview,
  upsertReview,
  validateReview,
  workKeyOf,
} from './reviews.js'
import { joinWaitlist, leaveWaitlist, waitCountsFor, waitlistFor } from './waitlist.js'
import { badgesOf } from './badges.js'
import { suggestPeople } from './people.js'
import { impact } from './impact.js'
import { prewarmCoverage } from './prewarm.js'
import { createHmac } from 'node:crypto'
import sharp from 'sharp'
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
 * Числовой query-параметр с дефолтом и границами: `limit=abc` раньше уезжал
 * NaN'ом в prisma take и ронял ручку 500-й; отрицательные и гигантские
 * значения зажимаются в допустимый диапазон.
 */
function intParam(v: string | undefined, def: number, min: number, max: number): number {
  if (v === undefined || v === '') return def
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** Город из query: принимаем только известные проекту значения. */
const isKnownCity = (city: string): boolean => (CITIES as readonly string[]).includes(city)

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

type ShowcaseRow = { id: string; title: string; coverUrl: string }

/**
 * Витрина карусели с кэшем, который переживает рестарт.
 *
 * Память сбрасывается на каждом деплое, а деплоев в день бывает несколько: без
 * этого каждый рестарт выбирал НОВУЮ случайную дюжину, её превью были холодные,
 * и первый посетитель платил за 12 промахов (замер: 24 запроса дольше 2 секунд
 * подряд). Поэтому выбранная дюжина лежит ещё и в базе (SyncState) и после
 * рестарта достаётся оттуда — вместе с уже прогретым кэшем картинок.
 */
async function showcaseFor(city: string | undefined, limit: number) {
  const key = `showcase:${city || '*'}:${limit}`
  const hit = showcaseCache.get(key)
  if (hit && Date.now() - hit.at < SHOWCASE_TTL) return hit.data

  const stored = await prisma.syncState.findUnique({ where: { key } }).catch(() => null)
  if (stored && Date.now() - stored.updatedAt.getTime() < SHOWCASE_TTL) {
    try {
      const rows = JSON.parse(stored.value) as ShowcaseRow[]
      const data = rows.map((r) => ({ ...r, coverUrl: proxyCover(r.coverUrl, CAROUSEL_W) }))
      showcaseCache.set(key, { at: stored.updatedAt.getTime(), data })
      return data
    } catch {
      /* мусор в записи — просто соберём витрину заново */
    }
  }

  const rows = city
    ? await prisma.$queryRaw<ShowcaseRow[]>`SELECT id, title, coverUrl FROM Book
        WHERE active = 1 AND reviewStatus = 'approved' AND coverUrl IS NOT NULL AND coverUrl <> ''
        AND city = ${city}
        ORDER BY RANDOM() LIMIT ${limit}`
    : await prisma.$queryRaw<ShowcaseRow[]>`SELECT id, title, coverUrl FROM Book
        WHERE active = 1 AND reviewStatus = 'approved' AND coverUrl IS NOT NULL AND coverUrl <> ''
        ORDER BY RANDOM() LIMIT ${limit}`
  // карусель показывает обложки на 156px — превью 320px (2× под retina) хватает
  const data = rows.map((r) => ({ ...r, coverUrl: proxyCover(r.coverUrl, CAROUSEL_W) }))
  showcaseCache.set(key, { at: Date.now(), data })
  await prisma.syncState
    .upsert({
      where: { key },
      create: { key, value: JSON.stringify(rows) },
      update: { value: JSON.stringify(rows) },
    })
    .catch(() => {})
  // прогреваем превью новой ротации в фоне — первый посетитель не должен
  // оплачивать все MISS сразу; не блокирует ответ, не await'им
  warmShowcaseCovers(rows.map((r) => r.coverUrl))
  return data
}

/**
 * Прогрев витрины при старте: после деплоя первым посетителем не должен быть
 * человек. Ошибку глотаем — это фоновая оптимизация, а не работа сервиса.
 */
export function warmShowcaseOnBoot() {
  setTimeout(() => {
    void showcaseFor(undefined, SHOWCASE_LIMIT_DEFAULT).catch(() => {})
  }, 5_000)
}

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
  /**
   * Пустое тело при `content-type: application/json` — это `{}`, а не ошибка.
   *
   * Дефолтный парсер Fastify отвечает на такой запрос 400
   * `FST_ERR_CTP_EMPTY_JSON_BODY`. Само по себе это било бы по удалению
   * (`DELETE /api/books/:id/review`, `/wait`): тела там нет по определению, и
   * любой клиент, ставящий заголовок по умолчанию, получал бы 400 на
   * совершенно корректном запросе. Свой Mini App заголовок при пустом теле не
   * шлёт и потому не страдал, но ловушка срабатывала на каждой ручной проверке
   * (дважды за две сессии) — а значит сработает и на стороннем клиенте.
   *
   * Кривой JSON остаётся ошибкой: 400 с понятным кодом.
   */
  app.addContentTypeParser<string>(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      if (typeof body !== 'string' || body.trim() === '') return done(null, {})
      try {
        done(null, JSON.parse(body))
      } catch {
        const err = new Error('bad_json') as Error & { statusCode?: number }
        err.statusCode = 400
        done(err, undefined)
      }
    },
  )

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
      // число городов — из справочника, а не хардкод «9» в двух местах фронта
      cities: CITIES.length,
      lastSync: sync?.value ?? null,
      ai: aiEnabled(),
      vision: visionEnabled(),
      notionWrite: notionWriteEnabled(),
      // адрес книжного клуба живёт в настройке сервера (CLUB_URL): так он один
      // и для меню бота, и для плашки на главной Mini App
      clubUrl: env.clubUrl,
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

  app.get('/api/facets', async (req, reply) => {
    const { city } = req.query as { city?: string }
    // facets кэшируется по городу — произвольная строка раздувала бы кэш
    if (city && !isKnownCity(city)) return reply.code(400).send({ error: 'unknown_city' })
    // рядом со «сколько чего есть» отдаём и справочник проекта: формы жанра и
    // языка выбирают ТОЛЬКО из него, свободного ввода там больше нет
    const [f, taxonomy] = await Promise.all([facets(city || undefined), getTaxonomy()])
    return { ...f, genreOptions: taxonomy.genres, languageOptions: taxonomy.languages }
  })

  app.get('/api/books', async (req) => {
    const q = req.query as Record<string, string>
    const found = await searchBooks({
      q: q.q?.slice(0, 200),
      city: q.city && isKnownCity(q.city) ? q.city : undefined,
      genre: q.genre?.slice(0, 100),
      language: q.language?.slice(0, 50),
      kind: q.kind === 'game' ? 'game' : q.kind === 'book' ? 'book' : undefined,
      ownerId: q.ownerId,
      limit: intParam(q.limit, 30, 1, 100),
      offset: intParam(q.offset, 0, 0, 100_000),
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
    // каждый уникальный city+limit — своя строка кэша и SyncState: произвольный
    // ?city= с улицы раздувал бы базу RANDOM()-запросами до бесконечности
    if (city && !isKnownCity(city)) return reply.code(400).send({ error: 'unknown_city' })
    const limit = intParam(limitRaw, SHOWCASE_LIMIT_DEFAULT, 1, SHOWCASE_LIMIT_MAX)
    reply.header('Cache-Control', 'private, max-age=1800')
    return showcaseFor(city, limit)
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

  /** Метрики image pipeline + прогрев каталога (HIT/MISS/NEGATIVE, по хостам, диск) — только админу. */
  app.get('/api/admin/img-metrics', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const user = await upsertUser(u)
    if (!user.isAdmin) return reply.code(403).send({ error: 'admin_only' })
    const [pipeline, prewarm] = await Promise.all([imgPipelineMetrics(), prewarmCoverage()])
    return json({ ...pipeline, prewarm })
  })

  app.get('/api/books/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const book = await bookById(id)
    if (!book) return reply.code(404).send({ error: 'not_found' })
    const u = who(req)
    // очередь на занятую книгу (issue #10): число ждущих и СВОЁ место в ней.
    // Ждущие друг друга не видят — наружу не уходит ни ников, ни tgId
    const waiting = await waitlistFor(id, u?.id ?? null)
    return json({ ...redactCard(book, maySeeContacts(req)), waiting })
  })

  /**
   * Подсказка людей при вводе ника («у кого моя книга»). Только по подписи и с
   * лимитом: это про своих, а не справочник ников всего проекта.
   */
  app.get('/api/people', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    if (tooOften(`people:${u.id}`, 60, 60_000)) return reply.code(429).send({ error: 'too_many' })
    const { q } = req.query as { q?: string }
    return json({ people: await suggestPeople(u.id, String(q ?? '').slice(0, 64)) })
  })

  /**
   * Сколько проект сберёг вместе (issue #13). Агрегат, поэтому публичен: в нём
   * нет ни одного человека, только число обменов и оценки по нему.
   */
  app.get('/api/impact', async () => json(await impact()))

  /**
   * Значки библиотекаря (issue #11). Только про себя и только по подписи:
   * публичный рейтинг превратил бы обмен книгами в соревнование.
   */
  app.get('/api/my-badges', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    return json(await badgesOf(u.id))
  })

  /**
   * Встать в очередь на занятую книгу: «сообщите, когда освободится».
   *
   * Только по подписи Telegram: обещание адресное, и отправлять его мы будем
   * в личку. Отказы говорят человеческим языком, что не так (см. waitlist.ts).
   */
  app.post('/api/books/:id/wait', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    await upsertUser(u)
    const { id } = req.params as { id: string }
    if (tooOften(`wait:${u.id}`, 30, 60_000)) return reply.code(429).send({ error: 'too_many' })
    const r = await joinWaitlist(u.id, id)
    if (!r.ok) return reply.code(r.error === 'book_unavailable' ? 404 : 409).send({ error: r.error })
    return json({ waiting: { count: r.count, mine: { position: r.position, status: 'waiting' } } })
  })

  /** Уйти из очереди. Повторный вызов не ошибка: результат тот же. */
  app.delete('/api/books/:id/wait', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const { id } = req.params as { id: string }
    await leaveWaitlist(u.id, id)
    return json({ waiting: await waitlistFor(id, u.id) })
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
      listLoans(u.id),
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
    let r
    try {
      r = await reopenLoan(id, u.id)
    } catch (e: any) {
      // гонка с параллельной выдачей: unique(activeBookId) сработал — это
      // честный конфликт 409, а не 500
      if (e?.code === 'P2002') return reply.code(409).send({ error: 'book_relent' })
      throw e
    }
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
    try {
      const loan = await markReturned(id, u.id)
      if (!loan) return reply.code(404).send({ error: 'not_found' })
      // читателю прилетает предложение оценить книгу — независимо от того,
      // закрыли выдачу кнопкой в боте или здесь, в Mini App
      void askForRating(loan)
      // и тем же путём уходит обещание «сообщим, когда освободится»
      void flushWaitlistNotices().catch(() => {})
      return json({ loan })
    } catch (e: any) {
      // «не ваша выдача» — 403, раньше неотличимо маскировалось под 404
      if (e?.message === 'forbidden') return reply.code(403).send({ error: 'forbidden' })
      throw e
    }
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
    // одобренные книги на полке, включая выданные: занятые нужны Mini App, чтобы
    // объяснить, почему книги нет в подсказке («уже на руках»), — фильтрует их клиент
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
    // владельцу показываем, сколько человек ждёт его книгу — но не кто именно
    const waits = await waitCountsFor(rows.map((b) => b.id))
    return json({
      books: rows.map((b) => ({
        ...toCard(b, { w: CARD_W }),
        state: shelfState(b),
        waitCount: waits.get(b.id) ?? 0,
      })),
    })
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

  /* ── оценки и аннотации (issue #18) ─────────────────────── */

  /**
   * Отзывы о книге. Каталог публичный, поэтому читать их можно без подписи;
   * `canReview`/`mine` появляются только у запроса из Mini App.
   */
  app.get('/api/books/:id/reviews', async (req, reply) => {
    const { id } = req.params as { id: string }
    const book = await prisma.book.findUnique({
      where: { id },
      select: { id: true, title: true, author: true },
    })
    if (!book) return reply.code(404).send({ error: 'not_found' })

    const u = who(req)
    const workKey = workKeyOf(book)
    const [rating, items, allowed] = await Promise.all([
      ratingFor(workKey),
      listReviews(workKey, u ? u.id : null),
      u ? canReview(u.id, workKey) : Promise.resolve(false),
    ])
    return json({
      rating,
      items,
      // подписан ли запрос: жалоба требует авторизации, и кнопку «пожаловаться»
      // не за чем показывать тому, у кого она заведомо ответит 401
      signed: Boolean(u),
      canReview: allowed,
      // «я уже оценил» фронту нужно отдельным полем: свой отзыв показывается
      // в форме, а не только в общем списке
      myReview: items.find((r) => r.mine) ?? null,
      textMax: REVIEW_TEXT_MAX,
    })
  })

  /** Поставить/обновить свою оценку. Право даёт только прочтение книги. */
  app.post('/api/books/:id/review', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    await upsertUser(u)
    const { id } = req.params as { id: string }
    const book = await prisma.book.findUnique({
      where: { id },
      select: { id: true, title: true, author: true },
    })
    if (!book) return reply.code(404).send({ error: 'not_found' })

    let parsed
    try {
      parsed = validateReview(req.body as { rating: unknown; text?: unknown })
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message ?? 'bad_request' })
    }

    const workKey = workKeyOf(book)
    if (!(await canReview(u.id, workKey))) return reply.code(403).send({ error: 'not_read' })

    const { rating } = await upsertReview({
      authorTg: u.id,
      book,
      rating: parsed.rating,
      text: parsed.text,
    })
    return json({ rating, items: await listReviews(workKey, u.id) })
  })

  /** Удалить свою оценку. */
  app.delete('/api/books/:id/review', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const { id } = req.params as { id: string }
    const book = await prisma.book.findUnique({
      where: { id },
      select: { title: true, author: true },
    })
    if (!book) return reply.code(404).send({ error: 'not_found' })
    const workKey = workKeyOf(book)
    const r = await deleteReview(u.id, workKey)
    if (!r.deleted) return reply.code(404).send({ error: 'not_found' })
    return json({ rating: r.rating, items: await listReviews(workKey, u.id) })
  })

  /** Пожаловаться на чужой отзыв: постмодерация вместо предварительной. */
  app.post('/api/reviews/:id/report', async (req, reply) => {
    const u = who(req)
    if (!u) return reply.code(401).send({ error: 'unauthorized' })
    const { id } = req.params as { id: string }
    const r = await reportReview(id, u.id)
    if ('error' in r) {
      return reply.code(r.error === 'own_review' ? 400 : 404).send({ error: r.error })
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
    if (!isKnownCity(b.city)) return reply.code(400).send({ error: 'unknown_city' })
    const startsAt = new Date(b.startsAt)
    // кривая дата раньше уезжала Invalid Date'ом в prisma и роняла ручку 500-й
    if (Number.isNaN(startsAt.getTime())) return reply.code(400).send({ error: 'bad_date' })
    const ev = await prisma.event.create({
      data: {
        city: b.city,
        title: b.title.slice(0, 200),
        startsAt,
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
    return json(
      items.map((i) => {
        const r = redactMarketItem(i, allowed) as Record<string, any>
        // сырой file_id превращаем в подписанную ссылку — только такие
        // ссылки обслуживает /api/photo (см. ниже), это не открытый прокси
        if (r.photo && !/^https?:\/\//.test(r.photo) && !r.photo.startsWith('/')) {
          r.photo = photoProxyUrl(r.photo)
        }
        return r
      }),
    )
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

    // список языков — из справочника Notion, а не из копии в коде
    const { languages } = await getTaxonomy()
    return json({ cover: saved.url, recognized, dup, extraBooks, languages })
  })

  /** Своя обложка; с ?w= — превью нужной ширины через тот же sharp-конвейер. */
  app.get('/api/cover/:file', async (req, reply) => {
    const { file } = req.params as { file: string }
    const { w } = req.query as { w?: string }
    const width = w ? Number(w) : null
    const found =
      width && ALLOWED_WIDTHS.includes(width)
        ? await readCoverVariant(file, width)
        : await readCover(file) // без ?w= (ссылка в Notion) — оригинал, как раньше
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

    let coverUrl: string | null = b.coverUrl ? String(b.coverUrl).slice(0, 1000) : null
    // coverUrl от пользователя нельзя брать на веру — иначе через него можно
    // заставить сервер сходить внутрь сети (SSRF). Принимаем ТОЛЬКО http(s) на
    // публичный хост: раньше произвольный мусор (не-URL) проходил в базу и Notion.
    if (coverUrl && (!/^https?:\/\//i.test(coverUrl) || !isSafeCoverUrl(coverUrl))) {
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

  /**
   * Фото объявлений барахолки (Telegram file_id → байты для Mini App).
   *
   * Это НЕ открытый прокси: `<img>` не умеет слать заголовки, поэтому вместо
   * initData ссылка несёт подпись, которую проставляет только сам сервер в
   * `/api/market` — обслуживаются исключительно file_id из нашей барахолки.
   * Плюс: лимиты частоты, таймауты, потолок размера С ОБРЫВОМ по ходу чтения
   * (не 20 МБ в память), проверка фактического декода и перекодирование в webp
   * (заодно срезает EXIF/GPS). В логи не попадают ни токен бота, ни file URL.
   */
  app.get('/api/photo/:fileId', async (req, reply) => {
    const { fileId } = req.params as { fileId: string }
    const { s } = req.query as { s?: string }
    if (!fileId || fileId.length > 200 || !/^[\w-]+$/.test(fileId)) {
      return reply.code(400).send({ error: 'bad_file_id' })
    }
    if (!s || s !== signPhoto(fileId)) return reply.code(403).send({ error: 'bad_signature' })
    if (tooOften(`photo:${req.ip}`, 60, 60_000) || tooOften('photo:*', 600, 60_000)) {
      return reply.code(429).send({ error: 'too_many' })
    }

    try {
      const metaRes = await fetchWithTimeout(
        `https://api.telegram.org/bot${env.botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
        {},
        10_000,
      )
      const meta = (await metaRes.json().catch(() => null)) as {
        ok: boolean
        result?: { file_path: string }
      } | null
      if (!meta?.ok || !meta.result?.file_path) return reply.code(404).send({ error: 'not_found' })

      const file = await fetchWithTimeout(
        `https://api.telegram.org/file/bot${env.botToken}/${meta.result.file_path}`,
        {},
        15_000,
      )
      if (!file.ok) return reply.code(502).send({ error: 'upstream_failed' })
      const type = file.headers.get('content-type') || 'image/jpeg'
      if (!type.startsWith('image/')) return reply.code(415).send({ error: 'not_an_image' })
      const raw = await readBodyLimited(file, PHOTO_MAX_BYTES)

      // фактический декод обязателен: Content-Type можно прислать любой
      let body: Buffer
      try {
        body = await sharp(raw, { failOn: 'none' })
          .rotate()
          .resize({ width: PHOTO_MAX_W, withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer()
      } catch {
        return reply.code(415).send({ error: 'bad_image' })
      }
      reply.header('Cache-Control', 'public, max-age=86400')
      reply.type('image/webp')
      return reply.send(body)
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      if (msg === 'too_large') return reply.code(413).send({ error: 'too_large' })
      const timedOut = msg.startsWith('timeout_')
      // без url — в нём токен бота; категории достаточно
      req.log.warn(`[photo] файл не получен: ${timedOut ? 'timeout' : 'network'}`)
      return reply.code(timedOut ? 504 : 502).send({ error: 'upstream_failed' })
    }
  })
}

/** Подпись фото-ссылки: обслуживаем только file_id, которые сами и выдали. */
const signPhoto = (fileId: string) =>
  createHmac('sha256', env.webhookSecret).update(`photo:${fileId}`).digest('hex').slice(0, 16)

export const photoProxyUrl = (fileId: string) =>
  `/api/photo/${encodeURIComponent(fileId)}?s=${signPhoto(fileId)}`

const PHOTO_MAX_BYTES = 5 * 1024 * 1024
const PHOTO_MAX_W = 640 // объявление в списке — не больше этого на экране
