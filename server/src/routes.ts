import type { FastifyInstance, FastifyRequest } from 'fastify'
import { prisma } from './db.js'
import { env } from './env.js'
import { upsertUser, verifyInitData, type TgUser } from './auth.js'
import { bookById, facets, searchBooks, toCard } from './search.js'
import { askAi, aiEnabled } from './ai.js'
import { CITIES } from './seed.js'
import { decodeDataUrl, readCover, saveCover } from './covers.js'
import { recognizeCover, visionEnabled, LANGUAGES } from './vision.js'
import {
  findDuplicates,
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

/** Достаёт пользователя из заголовка X-Init-Data, либо null. */
function who(req: FastifyRequest): TgUser | null {
  const raw = (req.headers['x-init-data'] as string) || ''
  return verifyInitData(raw)
}

const json = (v: unknown) =>
  JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)))

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
    return searchBooks({
      q: q.q,
      city: q.city,
      genre: q.genre,
      language: q.language,
      kind: q.kind === 'game' ? 'game' : q.kind === 'book' ? 'book' : undefined,
      ownerId: q.ownerId,
      limit: q.limit ? Number(q.limit) : 30,
      offset: q.offset ? Number(q.offset) : 0,
    })
  })

  app.get('/api/books/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const book = await bookById(id)
    if (!book) return reply.code(404).send({ error: 'not_found' })
    return book
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
    return json({ owner, books: books.map(toCard) })
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
      given: given.map(decorate),
      taken: taken.map(decorate),
      history: history.map((l) => ({
        ...l,
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
      return json({ loan, inviteUrl: `https://t.me/${botUsername()}?start=loan_${loan.id}` })
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
    return json(books.map(toCard))
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
    return json({ books: rows.map((b) => ({ ...toCard(b), state: shelfState(b) })) })
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
    return json(await digest(period === 'month' ? 'month' : 'day', city || undefined))
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
    return prisma.event.findMany({
      where: {
        startsAt: { gte: new Date(Date.now() - 6 * 3600_000) },
        ...(city ? { city } : {}),
      },
      orderBy: { startsAt: 'asc' },
      take: 50,
    })
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
    return json(items)
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

    const [saved, recognized] = await Promise.all([
      saveCover(decoded),
      recognizeCover(decoded.data, decoded.mediaType).catch((e) => {
        req.log.warn(`распознавание не удалось: ${e?.message ?? e}`)
        return null
      }),
    ])

    const duplicates = recognized?.title
      ? await findDuplicates(recognized.title, recognized.author)
      : []

    return json({ cover: saved.url, recognized, duplicates, languages: LANGUAGES })
  })

  app.get('/api/cover/:file', async (req, reply) => {
    const { file } = req.params as { file: string }
    const found = await readCover(file)
    if (!found) return reply.code(404).send({ error: 'not_found' })
    reply.header('Cache-Control', 'public, max-age=31536000, immutable')
    reply.type(found.type)
    return reply.send(found.body)
  })

  /** Проверка дублей до сохранения — лайфхак из инструкции проекта. */
  app.get('/api/duplicates', async (req) => {
    const { title, author } = req.query as { title?: string; author?: string }
    return json(await findDuplicates(title || '', author))
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
