/**
 * Единая точка идентификации библиотекаря.
 *
 * Раньше бот искал владельца только по `tgId`, а синк заводил его по `notionId`
 * без `tgId` — импортированный из Notion библиотекарь не находился, и бот плодил
 * второго. Отсюда дубли и пустая «Моя полка».
 *
 * `linkLibrarian` разрешает владельца по порядку:
 *   1) по `tgId` (самый надёжный ключ);
 *   2) по нормализованному нику — и тогда привязывает `tgId` к найденной записи,
 *      подтягивая старую полку человека;
 *   3) только если не нашли — создаёт новую (когда это разрешено).
 *
 * Основной идентификатор — `tgId`. Ник изменяем, поэтому уже занятую другим
 * человеком запись мы не перехватываем.
 */
import type { Librarian } from '@prisma/client'
import { prisma } from './db.js'
import { normHandle } from './notion.js'
import { notionWriteEnabled, updateOwnerTelegram } from './notion-write.js'

export type LibIdentity = {
  tgId: bigint
  username?: string | null
  firstName?: string | null
  city?: string | null
  district?: string | null
}

/** Уведомление админам, когда по одному нику нашлось несколько незанятых записей. */
type MergeNotifier = (
  primary: Librarian,
  others: Librarian[],
  input: LibIdentity,
) => void | Promise<void>
let mergeNotifier: MergeNotifier | null = null
export const setMergeNotifier = (fn: MergeNotifier) => {
  mergeNotifier = fn
}

/** Уведомление админам, когда обновлённый контакт не удалось отправить в Notion. */
type TelegramFailNotifier = (lib: Librarian, error: string) => void | Promise<void>
let telegramFailNotifier: TelegramFailNotifier | null = null
export const setTelegramFailNotifier = (fn: TelegramFailNotifier) => {
  telegramFailNotifier = fn
}

/**
 * Отправляет обновлённый @Telegram в Notion. При успехе снимает флаг очереди,
 * при ошибке — оставляет (дожмём позже) и говорит админам. Ничего не бросает:
 * зовётся «в фоне», не блокируя ответ пользователю.
 */
async function syncTelegramToNotion(lib: Librarian): Promise<void> {
  if (!lib.notionId || !notionWriteEnabled()) return
  try {
    await updateOwnerTelegram(lib.notionId, lib.telegram)
    await prisma.librarian.update({
      where: { id: lib.id },
      data: { telegramSyncPending: false },
    })
  } catch (e: any) {
    // флаг telegramSyncPending остаётся — дожмёт flushTelegramUpdates
    await Promise.resolve(telegramFailNotifier?.(lib, e?.message ?? String(e))).catch(() => {})
  }
}

/**
 * Дожимает контакты, не уехавшие в Notion (нет сети, протух токен).
 * Зовётся из синка и админской команды — как flushPending для книг.
 */
export async function flushTelegramUpdates(limit = 100): Promise<{ ok: number; failed: number }> {
  if (!notionWriteEnabled()) return { ok: 0, failed: 0 }
  const rows = await prisma.librarian.findMany({
    where: { telegramSyncPending: true, notionId: { not: null } },
    take: limit,
  })
  let ok = 0
  let failed = 0
  for (const lib of rows) {
    try {
      await updateOwnerTelegram(lib.notionId!, lib.telegram)
      await prisma.librarian.update({ where: { id: lib.id }, data: { telegramSyncPending: false } })
      ok++
    } catch {
      failed++
    }
  }
  return { ok, failed }
}

export const pendingTelegramCount = () =>
  prisma.librarian.count({ where: { telegramSyncPending: true, notionId: { not: null } } })

/**
 * Главная запись из группы дублей: с `notionId` (она останется в синке),
 * затем с уже привязанным `tgId`, иначе — старейшая.
 */
export function pickPrimary<
  T extends { notionId: string | null; tgId: bigint | null; createdAt: Date },
>(cands: T[]): T {
  return [...cands].sort((a, b) => {
    if (!!a.notionId !== !!b.notionId) return a.notionId ? -1 : 1
    if (!!a.tgId !== !!b.tgId) return a.tgId ? -1 : 1
    return a.createdAt.getTime() - b.createdAt.getTime()
  })[0]
}

/** Пустые поля записи добираем свежими данными, существующие не затираем. */
function backfill(lib: Librarian, input: LibIdentity, norm: string | null) {
  const data: Record<string, unknown> = { lastTelegramSyncAt: new Date() }
  if (!lib.tgId) data.tgId = input.tgId
  if (!lib.telegram && input.username) data.telegram = input.username
  if (!lib.telegramNorm && norm) data.telegramNorm = norm
  if (!lib.city && input.city) data.city = input.city
  if (!lib.district && input.district) data.district = input.district
  if ((!lib.name || lib.name === 'Библиотекарь') && (input.firstName || input.username)) {
    data.name = input.firstName || input.username
  }
  return data
}

/**
 * Находит (и при необходимости заводит) библиотекаря для этого Telegram-пользователя.
 * @returns запись владельца; `null` — если не нашли и `allowCreate: false`.
 */
export async function linkLibrarian(
  input: LibIdentity,
  opts: { allowCreate: boolean },
): Promise<Librarian | null> {
  const norm = normHandle(input.username ?? null)

  // 1. уже привязан по tgId
  const byTgId = await prisma.librarian.findUnique({ where: { tgId: input.tgId } })
  if (byTgId) {
    const data = backfill(byTgId, input, norm)
    // #2: ник в Telegram сменился — контакт правим сразу (tgId надёжен, ник изменчив)
    const storedNorm = byTgId.telegramNorm ?? normHandle(byTgId.telegram)
    const changed = norm !== null && norm !== storedNorm
    if (changed) {
      data.telegram = input.username
      data.telegramNorm = norm
      if (byTgId.notionId && notionWriteEnabled()) data.telegramSyncPending = true
    }
    const updated = await prisma.librarian.update({ where: { id: byTgId.id }, data })
    // отправку в Notion не ждём — ответ пользователю не должен зависеть от неё
    if (changed && updated.telegramSyncPending) void syncTelegramToNotion(updated)
    return updated
  }

  // 2. по нормализованному нику — среди не-архивных и ещё не занятых записей
  if (norm) {
    const cands = await prisma.librarian.findMany({
      where: { telegramNorm: norm, mergedIntoId: null },
    })
    const free = cands.filter((c) => c.tgId === null)
    if (free.length) {
      const primary = pickPrimary(free)
      const linked = await prisma.librarian.update({
        where: { id: primary.id },
        data: backfill(primary, input, norm),
      })
      // несколько незанятых записей на один ник — просим админов свести вручную
      if (free.length > 1 && mergeNotifier) {
        const others = free.filter((c) => c.id !== primary.id)
        await Promise.resolve(mergeNotifier(linked, others, input)).catch(() => {})
      }
      return linked
    }
    // кандидаты заняты другими tgId → это другой человек (ник совпал/переназначен)
  }

  // 3. новой записи ещё нет
  if (!opts.allowCreate) return null
  return prisma.librarian.create({
    data: {
      name: input.firstName || input.username || 'Библиотекарь',
      telegram: input.username ?? null,
      telegramNorm: norm,
      city: input.city ?? null,
      district: input.district ?? null,
      tgId: input.tgId,
      lastTelegramSyncAt: new Date(),
    },
  })
}
