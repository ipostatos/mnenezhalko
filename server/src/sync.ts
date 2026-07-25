import { prisma, buildSearch } from './db.js'
import { env } from './env.js'
import { fetchBooks, fetchGames, fetchLibrarians, normHandle } from './notion.js'
import { flushPending } from './publish.js'
import { flushTelegramUpdates } from './librarian.js'
import { invalidateFacets } from './search.js'

export type SyncReport = {
  librarians: number
  books: number
  games: number
  deactivated: number
  /** массовое исчезновение книг из Notion — деактивация пропущена (см. deactivationGuard) */
  suspicious: boolean
  ms: number
}

/**
 * Предохранитель от массового скрытия книг: неофициальный Notion API может
 * вернуть НЕПОЛНЫЙ, но формально успешный ответ — тогда «пропавшие» книги нельзя
 * деактивировать оптом. Порог 15% при заметном объёме библиотеки.
 */
export function deactivationGuard(activeBefore: number, goneCount: number): { skip: boolean } {
  return { skip: activeBefore >= 20 && goneCount > Math.ceil(activeBefore * 0.15) }
}

// Уведомление админам о подозрительном синке (регистрирует бот).
let syncAlert: ((msg: string) => void) | null = null
export function setSyncAlert(fn: (msg: string) => void) {
  syncAlert = fn
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

  // и обновлённые контакты — тоже до чтения, чтобы не затянуть их же старыми значениями
  const contacts = await flushTelegramUpdates().catch((e) => {
    log(`[sync] отправка контактов не удалась: ${e?.message ?? e}`)
    return { ok: 0, failed: 0 }
  })
  if (contacts.ok || contacts.failed) {
    log(`[sync] контактов обновлено: ${contacts.ok}, с ошибкой: ${contacts.failed}`)
  }

  log('[sync] тяну библиотекарей…')
  const librarians = await fetchLibrarians()
  log(`[sync] библиотекарей: ${librarians.length}`)

  // контакты, чьё локальное изменение ещё не уехало в Notion: их telegram синком
  // НЕ перезаписываем, иначе откатим свежий ник старым значением из Notion
  const pendingContacts = new Set(
    (
      await prisma.librarian.findMany({
        where: { telegramSyncPending: true, notionId: { not: null } },
        select: { notionId: true },
      })
    ).map((l) => l.notionId!),
  )

  for (const l of librarians) {
    const contact = { telegram: l.telegram, telegramNorm: normHandle(l.telegram) }
    const common = { name: l.name, instagram: l.instagram, city: l.city, district: l.district }
    await prisma.librarian.upsert({
      where: { notionId: l.notionId },
      create: { notionId: l.notionId, ...common, ...contact },
      // у записи с невыполненной отправкой локальный контакт — источник правды
      update: pendingContacts.has(l.notionId) ? common : { ...common, ...contact },
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
  let deactivated = 0
  let suspicious = false
  if (gone.length) {
    if (deactivationGuard(stale.length, gone.length).skip) {
      suspicious = true
      const msg =
        `⚠️ Синк Notion подозрителен: из ${stale.length} книг «пропало» ${gone.length} (> 15%). ` +
        `Деактивация ПРОПУЩЕНА — вероятно, неполный ответ Notion. Проверьте таблицу и запустите синк вручную.`
      log(`[sync] ${msg}`)
      syncAlert?.(msg)
    } else {
      await prisma.book.updateMany({ where: { id: { in: gone } }, data: { active: false } })
      deactivated = gone.length
    }
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
    deactivated,
    suspicious,
    ms: Date.now() - started,
  }
  log(`[sync] готово за ${(report.ms / 1000).toFixed(1)}с, скрыто ${deactivated}`)
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
