import { prisma, buildSearch } from './db.js'
import { env } from './env.js'
import { fetchBooks, fetchGames, fetchLibrarians, normHandle } from './notion.js'
import { flushPending } from './publish.js'
import { invalidateFacets } from './search.js'

export type SyncReport = {
  librarians: number
  books: number
  games: number
  deactivated: number
  ms: number
}

/**
 * Полная синхронизация из Notion. Идемпотентна: строки матчатся по notionId,
 * записи, добавленные через бота (source = 'bot'), не трогаются.
 */
export async function syncFromNotion(log = console.log): Promise<SyncReport> {
  const started = Date.now()

  // сначала отдаём в Notion свои карточки, иначе синк их не увидит
  const pushed = await flushPending().catch((e) => {
    log(`[sync] отправка карточек в Notion не удалась: ${e?.message ?? e}`)
    return { ok: 0, failed: 0 }
  })
  if (pushed.ok || pushed.failed) {
    log(`[sync] отправлено в Notion: ${pushed.ok}, с ошибкой: ${pushed.failed}`)
  }

  log('[sync] тяну библиотекарей…')
  const librarians = await fetchLibrarians()
  log(`[sync] библиотекарей: ${librarians.length}`)

  for (const l of librarians) {
    const fields = {
      name: l.name,
      telegram: l.telegram,
      telegramNorm: normHandle(l.telegram),
      instagram: l.instagram,
      city: l.city,
      district: l.district,
    }
    await prisma.librarian.upsert({
      where: { notionId: l.notionId },
      create: { notionId: l.notionId, ...fields },
      update: fields,
    })
  }

  // владелец по notionId, но с учётом слияния дублей: если запись объединена в
  // другую, книги должны привязываться к главной — иначе синк вернёт их назад
  const allLibs = await prisma.librarian.findMany({
    select: { id: true, notionId: true, city: true, district: true, mergedIntoId: true },
  })
  const libById = new Map(allLibs.map((l) => [l.id, l]))
  const resolvePrimary = (l: (typeof allLibs)[number]) => {
    let cur = l
    const seen = new Set<string>()
    while (cur.mergedIntoId && libById.has(cur.mergedIntoId) && !seen.has(cur.id)) {
      seen.add(cur.id)
      cur = libById.get(cur.mergedIntoId)!
    }
    return cur
  }
  const ownerByNotion = new Map<string, { id: string; city: string | null; district: string | null }>()
  for (const l of allLibs) {
    if (!l.notionId) continue
    const p = resolvePrimary(l)
    ownerByNotion.set(l.notionId, { id: p.id, city: p.city ?? l.city, district: p.district ?? l.district })
  }

  log('[sync] тяну книги…')
  const books = await fetchBooks()
  log(`[sync] книг: ${books.length}`)
  log('[sync] тяну настолки…')
  const games = await fetchGames()
  log(`[sync] настолок: ${games.length}`)

  const seen = new Set<string>()
  for (const b of [...books, ...games]) {
    const owner = b.ownerNotionId ? ownerByNotion.get(b.ownerNotionId) : undefined
    const city = b.city ?? owner?.city ?? null
    const district = b.district ?? owner?.district ?? null
    const data = {
      kind: b.kind,
      title: b.title,
      author: b.author,
      genres: b.genres,
      languages: b.languages,
      coverUrl: b.coverUrl,
      status: b.status,
      addedAt: b.addedAt,
      city,
      district,
      ownerId: owner?.id ?? null,
      source: 'notion',
      active: true,
      search: buildSearch({
        title: b.title,
        author: b.author,
        genres: b.genres,
        languages: b.languages,
        city,
        district,
      }),
    }
    await prisma.book.upsert({
      where: { notionId: b.notionId },
      create: { notionId: b.notionId, ...data },
      update: data,
    })
    seen.add(b.notionId)
  }

  // то, что пропало из Notion, прячем, но не удаляем
  const stale = await prisma.book.findMany({
    where: { source: 'notion', active: true, notionId: { not: null } },
    select: { id: true, notionId: true },
  })
  const gone = stale.filter((b) => !seen.has(b.notionId!)).map((b) => b.id)
  if (gone.length) {
    await prisma.book.updateMany({ where: { id: { in: gone } }, data: { active: false } })
  }

  await prisma.syncState.upsert({
    where: { key: 'notion' },
    create: { key: 'notion', value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  })
  invalidateFacets()

  const report: SyncReport = {
    librarians: librarians.length,
    books: books.length,
    games: games.length,
    deactivated: gone.length,
    ms: Date.now() - started,
  }
  log(`[sync] готово за ${(report.ms / 1000).toFixed(1)}с, скрыто ${gone.length}`)
  return report
}

/** Периодический фоновой синк (по умолчанию раз в 12 часов). */
export function startSyncLoop() {
  if (!env.notion.syncHours) return
  const runSafe = () =>
    syncFromNotion().catch((e) => console.error('[sync] ошибка:', e?.message || e))
  const timer = setInterval(runSafe, env.notion.syncHours * 3600_000)
  timer.unref?.()
}
