/**
 * Фоновый прогрев превью обложек всего активного каталога (аудит 2026-07-28, P0.4).
 *
 * Прогревалась только витрина (12 карточек) — ~75% каталога оставались холодными,
 * и первый показ каждой обложки был синхронным походом на внешний CDN внутри
 * запроса пользователя (замер: 14 холодных обложек = 6.06 с «волнами по 4»).
 *
 * Обход резюмируемый: курсор и счётчики лежат в SyncState, рестарт продолжает
 * с места остановки. Каждый прогон ограничен бюджетом (время и число реальных
 * походов на origin) — HTTP-запросам людей прогрев не мешает: он ходит через
 * те же семафоры (глобальный + per-host) и уважает негативный кэш. Греем w=96
 * (строки списков — самый частый случай); w=320 греет витрина, w=220 — по спросу.
 */
import { prisma } from './db.js'
import { LIST_W, isCachedExternal, warmCover } from './imgcache.js'
import { isCoverVariantCached, readCoverVariant } from './covers.js'
import type { JobDef } from './scheduler.js'

/** Поднять при смене конвейера превью — обход начнётся заново. */
export const PREWARM_VERSION = 1

const STATE_KEY = 'prewarm:state'
/** Бюджет одного прогона: не занимаем сеть/CPU дольше этого. */
const RUN_BUDGET_MS = Number(process.env.PREWARM_BUDGET_MS || 4 * 60_000)
/** И не больше стольких реальных походов на origin за прогон. */
const RUN_MAX_FETCHES = Number(process.env.PREWARM_MAX_FETCHES || 150)
/** Завершённый проход повторяем не чаще раза в сутки (новые книги ловит каждый прогон). */
const FULL_PASS_EVERY_MS = 24 * 3600_000

export type PrewarmState = {
  version: number
  /** createdAt+id последней обработанной книги; null — проход не начат/завершён */
  cursor: { createdAt: string; id: string } | null
  lastFullPassAt: string | null
  /** счётчики текущего/последнего прохода */
  pass: { hit: number; miss: number; negative: number; skipped: number }
}

const freshState = (): PrewarmState => ({
  version: PREWARM_VERSION,
  cursor: null,
  lastFullPassAt: null,
  pass: { hit: 0, miss: 0, negative: 0, skipped: 0 },
})

export async function loadPrewarmState(): Promise<PrewarmState> {
  const row = await prisma.syncState.findUnique({ where: { key: STATE_KEY } }).catch(() => null)
  if (!row) return freshState()
  try {
    const s = JSON.parse(row.value) as PrewarmState
    // смена версии конвейера — старый прогресс не считается
    if (s.version !== PREWARM_VERSION) return freshState()
    return { ...freshState(), ...s }
  } catch {
    return freshState()
  }
}

async function saveState(s: PrewarmState): Promise<void> {
  const value = JSON.stringify(s)
  await prisma.syncState
    .upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value }, update: { value } })
    .catch(() => {})
}

/** Книги, чьи превью греем: активные, одобренные, с обложкой. */
const prewarmWhere = {
  active: true,
  reviewStatus: 'approved',
  coverUrl: { not: null },
  NOT: { coverUrl: '' },
} as const

const ownCoverFile = (url: string): string | null =>
  url.match(/\/api\/cover\/([\w-]+\.\w+)/)?.[1] ?? null

/**
 * Один прогон: продолжает незавершённый проход от курсора, греет холодные
 * превью в пределах бюджета. Возвращает сводку для лога планировщика.
 */
export async function prewarmRun(now = Date.now()): Promise<string> {
  let s = await loadPrewarmState()

  // проход завершён недавно — новый начинаем не чаще раза в сутки; свежие книги
  // при этом всё равно проверяются каждый прогон (они в хвосте по createdAt,
  // а завершённый проход перезапускается лишь от курсора null — поэтому для
  // новых книг ниже есть отдельная быстрая ветка «хвост после lastFullPassAt»)
  const passDone = !s.cursor && s.lastFullPassAt
  const passFresh = passDone && now - Date.parse(s.lastFullPassAt!) < FULL_PASS_EVERY_MS
  const sinceFull = passFresh ? new Date(Date.parse(s.lastFullPassAt!) - 3600_000) : null

  if (!passDone || !passFresh) {
    if (passDone) s = { ...s, cursor: null, pass: { hit: 0, miss: 0, negative: 0, skipped: 0 } }
  }

  const deadline = now + RUN_BUDGET_MS
  let fetches = 0
  let processed = 0

  for (;;) {
    if (Date.now() > deadline || fetches >= RUN_MAX_FETCHES) break
    const batch = await prisma.book.findMany({
      where: {
        ...prewarmWhere,
        // свежий полный проход: смотрим только книги, появившиеся после него
        ...(sinceFull ? { createdAt: { gt: sinceFull } } : {}),
        ...(s.cursor
          ? {
              OR: [
                { createdAt: { gt: new Date(s.cursor.createdAt) } },
                { createdAt: new Date(s.cursor.createdAt), id: { gt: s.cursor.id } },
              ],
            }
          : {}),
      },
      select: { id: true, coverUrl: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 50,
    })
    if (!batch.length) {
      // дошли до конца каталога — проход завершён
      if (!sinceFull) s.lastFullPassAt = new Date().toISOString()
      s.cursor = null
      break
    }

    for (const b of batch) {
      if (Date.now() > deadline || fetches >= RUN_MAX_FETCHES) break
      const url = b.coverUrl!
      processed++
      s.cursor = { createdAt: b.createdAt.toISOString(), id: b.id }

      const own = ownCoverFile(url)
      if (own) {
        // своё фото: вариант генерируется локально, сеть не нужна
        if (!(await isCoverVariantCached(own, LIST_W))) {
          await readCoverVariant(own, LIST_W).catch(() => {})
          s.pass.miss++
        } else s.pass.hit++
        continue
      }
      if (!/^https?:\/\//.test(url)) {
        s.pass.skipped++
        continue
      }
      if (await isCachedExternal(url, LIST_W)) {
        s.pass.hit++
        continue
      }
      // холодная — идём на origin (через общие семафоры и негативный кэш)
      const r = await warmCover(url, LIST_W)
      if (r === 'MISS') {
        s.pass.miss++
        fetches++
      } else if (r === 'NEGATIVE') {
        s.pass.negative++
        fetches++ // поход (или короткое замыкание) по мёртвому — тоже считаем к бюджету
      } else if (r === 'HIT') s.pass.hit++
      else s.pass.skipped++
    }
    await saveState(s) // курсор двигаем после каждой пачки — рестарт продолжит отсюда
  }

  await saveState(s)
  const p = s.pass
  const tail = s.cursor ? 'проход продолжится' : sinceFull ? 'хвост новых книг проверен' : 'проход завершён'
  return `обработано ${processed}, тёплых ${p.hit}, загружено ${p.miss}, недоступно ${p.negative}, пропущено ${p.skipped} — ${tail}`
}

/**
 * Прогресс прогрева для админской метрики: сколько активных обложек каталога
 * уже имеют превью w=96. Обходит диск stat'ами — только по запросу админа.
 */
export async function prewarmCoverage(): Promise<{
  totalCovers: number
  warmed: number
  coveragePct: number
  state: PrewarmState
}> {
  const books = await prisma.book.findMany({ where: prewarmWhere, select: { coverUrl: true } })
  let warmed = 0
  let total = 0
  for (const b of books) {
    const url = b.coverUrl!
    const own = ownCoverFile(url)
    if (own) {
      total++
      if (await isCoverVariantCached(own, LIST_W)) warmed++
    } else if (/^https?:\/\//.test(url)) {
      total++
      if (await isCachedExternal(url, LIST_W)) warmed++
    }
  }
  return {
    totalCovers: total,
    warmed,
    coveragePct: total ? Math.round((warmed / total) * 1000) / 10 : 100,
    state: await loadPrewarmState(),
  }
}

/** Джоба для планировщика: каждые 15 минут продолжаем/проверяем прогрев. */
export const coverPrewarmJob: JobDef = {
  name: 'cover-prewarm',
  periodMs: 15 * 60_000,
  bootDelayMs: 90_000, // после старта сначала витрина и люди, потом фон
  run: () => prewarmRun(),
}
