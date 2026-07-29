import { prisma, buildSearch } from './db.js'
import { env } from './env.js'
import {
  fetchBooks as realFetchBooks,
  fetchGames as realFetchGames,
  fetchLibrarians as realFetchLibrarians,
  normHandle,
  type NotionBook,
  type NotionLibrarian,
} from './notion.js'
import { flushPending } from './publish.js'
import { flushTelegramUpdates } from './librarian.js'
import { invalidateFacets } from './search.js'
import { runJobOnce } from './scheduler.js'
import { coverPrewarmJob } from './prewarm.js'
import { refreshTaxonomy } from './taxonomy.js'

/** Источники Notion — инъекция для тестов циркуит-брейкера, без реальной сети. */
export type SyncDeps = {
  fetchBooks: () => Promise<NotionBook[]>
  fetchGames: () => Promise<NotionBook[]>
  fetchLibrarians: () => Promise<NotionLibrarian[]>
  /** справочник жанров/языков из схемы той же таблицы книг */
  refreshTaxonomy: () => Promise<unknown>
}
const defaultDeps: SyncDeps = {
  fetchBooks: realFetchBooks,
  fetchGames: realFetchGames,
  fetchLibrarians: realFetchLibrarians,
  refreshTaxonomy,
}

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
 * деактивировать оптом. Пороги настраиваются через env (NOTION_SYNC_GUARD_MIN/PCT),
 * по умолчанию 20 книг объёма и 15% потери.
 */
export function deactivationGuard(
  activeBefore: number,
  goneCount: number,
  minVolume = env.notion.guardMinVolume,
  pct = env.notion.guardPercent,
): { skip: boolean } {
  return { skip: activeBefore >= minVolume && goneCount > Math.ceil(activeBefore * pct) }
}

// Уведомление админам о подозрительном синке (регистрирует бот).
let syncAlert: ((msg: string) => void) | null = null
export function setSyncAlert(fn: (msg: string) => void) {
  syncAlert = fn
}

// Синк не должен идти в два потока: фоновый цикл сериализован сам по себе, но
// ручной /sync или sync-cli могли наложиться на него и погонять upsert'ы вперегонки.
let syncInProgress = false

/**
 * Полная синхронизация из Notion. Идемпотентна: строки матчатся по notionId,
 * записи, добавленные через бота (source = 'bot'), не трогаются.
 */
export async function syncFromNotion(log = console.log, deps: SyncDeps = defaultDeps): Promise<SyncReport> {
  if (syncInProgress) throw new Error('синк уже идёт — дождитесь завершения')
  syncInProgress = true
  try {
    return await runSync(log, deps)
  } finally {
    syncInProgress = false
  }
}

async function runSync(log: typeof console.log, deps: SyncDeps): Promise<SyncReport> {
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
  const librarians = await deps.fetchLibrarians()
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
    const common: Record<string, unknown> = { name: l.name, instagram: l.instagram }
    // Город из Notion применяем, только если он там ЗАПОЛНЕН: пустое City не
    // должно затирать локальный backfill — иначе книги владельца каждые 12 часов
    // выпадали из городских фильтров (см. docs/DATA_OWNERSHIP.md).
    if (l.city) {
      common.city = l.city
      common.district = l.district
    }
    await prisma.librarian.upsert({
      where: { notionId: l.notionId },
      create: { notionId: l.notionId, name: l.name, instagram: l.instagram, city: l.city, district: l.district, ...contact },
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

  // Книги и настолки — независимые источники: если один упал, это не должно
  // ни срывать другой (иначе одна временная ошибка games откатывает уже
  // успешно прочитанные books), ни считаться «увидели всё» для упавшего —
  // деактивация по нему в этом прогоне просто не выполняется (см. ниже).
  let books: NotionBook[] = []
  let games: NotionBook[] = []
  let booksOk = true
  let gamesOk = true
  try {
    log('[sync] тяну книги…')
    books = await deps.fetchBooks()
    log(`[sync] книг: ${books.length}`)
  } catch (e: any) {
    booksOk = false
    log(`[sync] книги не загрузились: ${e?.message ?? e}`)
  }
  try {
    log('[sync] тяну настолки…')
    games = await deps.fetchGames()
    log(`[sync] настолок: ${games.length}`)
  } catch (e: any) {
    gamesOk = false
    log(`[sync] настолки не загрузились: ${e?.message ?? e}`)
  }

  /**
   * Merge-правила источников истины (docs/DATA_OWNERSHIP.md): Notion владеет
   * библиографией, но НЕ владеет локальным состоянием — статусом выдачи,
   * tombstone удаления, непустыми локальными правками города и датой добавления.
   * До этого upsert слепо перезаписывал всё: каждые 12 часов выданная книга
   * становилась «свободной», города обнулялись, удалённые книги воскресали.
   */
  const incoming = [...books, ...games]
  const existingRows = incoming.length
    ? await prisma.book.findMany({
        where: { notionId: { in: incoming.map((b) => b.notionId) } },
        select: {
          id: true,
          notionId: true,
          city: true,
          district: true,
          addedAt: true,
          reviewStatus: true,
          deletedAt: true,
        },
      })
    : []
  const existingByNotion = new Map(existingRows.map((b) => [b.notionId!, b]))
  // книга с активной выдачей остаётся busy, что бы ни сказал Notion (у книг
  // там вообще захардкожен free); после возврата выдача закрыта — статус free
  const busyBookIds = new Set(
    (
      await prisma.loan.findMany({
        where: { status: 'active', bookId: { not: null } },
        select: { bookId: true },
      })
    ).map((l) => l.bookId!),
  )

  const seen = new Set<string>()
  for (const b of incoming) {
    seen.add(b.notionId)
    const existing = existingByNotion.get(b.notionId)

    // tombstone: удалённую у нас книгу синк не воскрешает, даже если строка
    // осталась в Notion (архивирование могло упасть — его дожмёт flushPending)
    if (existing && (existing.reviewStatus === 'deleted' || existing.deletedAt)) continue

    const owner = b.ownerNotionId ? ownerByNotion.get(b.ownerNotionId) : undefined
    const cityIncoming = b.city ?? owner?.city ?? null
    const districtIncoming = b.district ?? owner?.district ?? null
    // непустое локальное значение города переживает пустое из Notion; непустой
    // город из Notion применяется (правки уезжают туда же через updateBook)
    const city = cityIncoming ?? existing?.city ?? null
    const district = cityIncoming ? districtIncoming : (existing?.district ?? districtIncoming)
    const status = existing && busyBookIds.has(existing.id) ? 'busy' : b.status
    const addedAt = b.addedAt ?? existing?.addedAt ?? null

    const data = {
      kind: b.kind,
      title: b.title,
      author: b.author,
      genres: b.genres,
      languages: b.languages,
      coverUrl: b.coverUrl,
      status,
      addedAt,
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
  }

  // То, что пропало из Notion, прячем, но не удаляем — отдельно для книг и
  // настолок: у упавшего источника в этом прогоне мы деактивацию не трогаем
  // вовсе (нет свежих данных — не считаем никого «пропавшим»), а не мешаем
  // его в общий процент со здоровым источником.
  let deactivated = 0
  let suspicious = false
  for (const [kind, ok] of [['book', booksOk], ['game', gamesOk]] as const) {
    if (!ok) {
      log(`[sync] источник «${kind}» не загрузился — деактивация по нему в этом прогоне пропущена`)
      continue
    }
    const stale = await prisma.book.findMany({
      where: { source: 'notion', active: true, notionId: { not: null }, kind },
      select: { id: true, notionId: true },
    })
    const gone = stale.filter((b) => !seen.has(b.notionId!)).map((b) => b.id)
    if (!gone.length) continue
    if (deactivationGuard(stale.length, gone.length).skip) {
      suspicious = true
      const msg =
        `⚠️ Синк Notion подозрителен (${kind}): из ${stale.length} «пропало» ${gone.length} ` +
        `(> ${Math.round(env.notion.guardPercent * 100)}%). Деактивация ПРОПУЩЕНА — вероятно, ` +
        `неполный ответ Notion. Проверьте таблицу и запустите синк вручную.`
      log(`[sync] ${msg}`)
      syncAlert?.(msg)
    } else {
      await prisma.book.updateMany({ where: { id: { in: gone } }, data: { active: false } })
      deactivated += gone.length
    }
  }

  // Baseline («последний ДОВЕРЕННЫЙ синк») продвигаем только если прогон был
  // полностью успешным: ни один источник не упал и предохранитель нигде не
  // сработал. Иначе /api/health продолжал бы честно показывать «недоверенные»
  // данные как последний успешный синк — подозрительный или частично упавший
  // прогон не должен маскироваться под штатный.
  const trusted = booksOk && gamesOk && !suspicious
  if (trusted) {
    await prisma.syncState.upsert({
      where: { key: 'notion' },
      create: { key: 'notion', value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })
  }
  invalidateFacets()

  // после синка могли появиться новые обложки — продолжаем прогрев, не дожидаясь
  // очередного тика планировщика (повторный запуск поверх идущего он пропустит сам)
  if (trusted) void runJobOnce(coverPrewarmJob)

  // справочник жанров/языков живёт в схеме той же таблицы: админ завёл новый
  // жанр в Notion — он появляется в приложении после ближайшего синка. Сбой тут
  // не должен ронять прогон: справочник останется прежним (см. taxonomy.ts)
  if (booksOk) {
    await deps.refreshTaxonomy().catch((e: any) =>
      log(`[sync] справочник жанров не обновился: ${e?.message ?? e}`),
    )
  }

  const report: SyncReport = {
    librarians: librarians.length,
    books: books.length,
    games: games.length,
    deactivated,
    suspicious,
    ms: Date.now() - started,
  }
  log(`[sync] готово за ${(report.ms / 1000).toFixed(1)}с, скрыто ${deactivated}${trusted ? '' : ' (baseline не обновлён)'}`)
  return report
}

/** Не бить по Notion сразу на старте: сначала подняться и начать отвечать. */
export const SYNC_BOOT_DELAY_MS = 30_000

/**
 * Сколько ждать до следующего синка. Считается от ПОСЛЕДНЕГО УСПЕШНОГО синка,
 * а не от старта процесса — иначе каждый рестарт (а деплой это рестарт) сбрасывает
 * отсчёт, и при нескольких деплоях в день фоновый синк не отрабатывает НИ РАЗУ.
 * Именно так и было: `setInterval` от старта + деплои = 25 часов без синка при
 * заявленных 12 (поймано на проде 2026-07-25).
 *
 * `null` в lastSync (синка ещё не было) — синкаемся сразу после загрузочной паузы.
 */
export function nextSyncDelayMs(
  lastSyncIso: string | null,
  now: number,
  syncHours: number,
  bootDelayMs = SYNC_BOOT_DELAY_MS,
): number {
  const periodMs = syncHours * 3600_000
  if (!lastSyncIso) return bootDelayMs
  const last = Date.parse(lastSyncIso)
  // битая/будущая метка не должна ни блокировать синк навсегда, ни ронять расчёт
  if (!Number.isFinite(last) || last > now) return bootDelayMs
  const due = last + periodMs
  return Math.max(bootDelayMs, due - now)
}

/** База повторной попытки после неудачного/подозрительного прогона. */
export const SYNC_RETRY_BASE_MS = 15 * 60_000

/**
 * Задержка повторной попытки: 15 мин, 30, 60… но не дольше обычного периода.
 * Нужна потому, что неудачный и подозрительный прогоны НЕ двигают lastSync —
 * планирование «от lastSync» само по себе дало бы срок в прошлом и превратилось
 * бы в непрерывный долбёж Notion.
 */
export function retryDelayMs(failures: number, syncHours: number, base = SYNC_RETRY_BASE_MS): number {
  const periodMs = syncHours * 3600_000
  const backoff = base * 2 ** Math.max(0, failures - 1)
  return Math.min(periodMs, backoff)
}

/**
 * Периодический фоновой синк (по умолчанию раз в 12 часов). Не `setInterval`:
 * после каждого прогона срок пересчитывается от фактического lastSync, поэтому
 * рестарт не «съедает» очередной синк. Прогон, который не обновил baseline
 * (упавший или подозрительный), повторяется с растущей паузой.
 */
export function startSyncLoop() {
  if (!env.notion.syncHours) return

  const readLastSync = async (): Promise<string | null> => {
    const row = await prisma.syncState.findUnique({ where: { key: 'notion' } })
    return row?.value ?? null
  }

  let failures = 0

  const schedule = async () => {
    let delay = SYNC_BOOT_DELAY_MS
    try {
      const last = await readLastSync()
      delay =
        failures > 0
          ? retryDelayMs(failures, env.notion.syncHours)
          : nextSyncDelayMs(last, Date.now(), env.notion.syncHours)
    } catch (e: any) {
      console.error('[sync] не смог прочитать lastSync:', e?.message || e)
    }
    const mins = Math.round(delay / 60_000)
    console.log(`[sync] следующий прогон через ${mins} мин${failures ? ` (попытка ${failures + 1})` : ''}`)
    const timer = setTimeout(async () => {
      // «удачным» считается только прогон, продвинувший baseline — то же условие,
      // по которому health показывает lastSync (см. trusted в syncFromNotion)
      const before = await readLastSync().catch(() => null)
      try {
        await syncFromNotion()
      } catch (e: any) {
        console.error('[sync] ошибка:', e?.message || e)
      }
      const after = await readLastSync().catch(() => before)
      failures = after && after !== before ? 0 : failures + 1
      schedule()
    }, delay)
    timer.unref?.()
  }

  void schedule()
}
