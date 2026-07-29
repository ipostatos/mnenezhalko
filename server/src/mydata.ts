/**
 * «Мои данные»: забрать всё, что о тебе есть, и удалить себя из проекта.
 *
 * Мы храним Telegram id, ник и имя, город, историю выдач (кто у кого что брал),
 * отзывы и очереди — это персональные данные и поведенческая история. Значит
 * человеку нужен рабочий способ их посмотреть и убрать, а не обещание в тексте.
 *
 * Устройство удаления:
 *   — то, что принадлежит только человеку (очереди, отзывы, жалобы, объявления,
 *     его фотографии), удаляется физически;
 *   — общая история обмена (закрытые выдачи) АНОНИМИЗИРУЕТСЯ: строка остаётся,
 *     но опознать в ней человека уже нельзя. Иначе из истории проекта пропали бы
 *     и чужие записи: у выдачи две стороны;
 *   — незакрытая выдача удаление блокирует: у кого-то на руках чужая книга, и
 *     стереть владельца — значит потерять её след. Сначала возврат.
 *
 * Всё выполняется одной транзакцией: не должно остаться «наполовину удалённого»
 * человека. Notion и файлы обложек чистятся после неё, отдельно (внешние вещи
 * в транзакцию базы не заворачиваются).
 */
import crypto from 'node:crypto'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { prisma } from './db.js'
import { env } from './env.js'
import { COVERS_DIR } from './covers.js'
import { archiveRow, notionWriteEnabled, updateOwnerTelegram } from './notion-write.js'
import { invalidateFacets } from './search.js'
import { plural } from './plural.js'
import { closeWaitlist } from './waitlist.js'

/** Имя вместо настоящего у анонимизированных записей. */
export const ERASED_NAME = 'Удалённый участник'

/**
 * Кому-то обещали сообщить, когда книга освободится, а книга ушла вместе с
 * владельцем. Молчать нельзя: человек ждёт письма, которое уже не придёт.
 * Текст нейтральный — почему книги не стало, никого не касается.
 */
export type BookGoneNotice = { userTg: bigint; title: string }
type BookGoneNotifier = (notices: BookGoneNotice[]) => void | Promise<void>
let bookGoneNotifier: BookGoneNotifier | null = null
export const setBookGoneNotifier = (fn: BookGoneNotifier) => {
  bookGoneNotifier = fn
}

/**
 * Отпечаток Telegram id для журнала удалений: сверить «этого ли человека
 * удаляли» можно, восстановить id — нет.
 *
 * Именно HMAC с отдельным секретом, а не sha256 от id. Telegram id — короткое
 * предсказуемое число: перебрать все правдоподобные значения и сопоставить
 * обычные хэши можно за секунды, и «в журнале только хэш» не значило бы ничего.
 * Ключ (`PRIVACY_DELETION_PEPPER`) живёт в окружении сервера — не в базе, не в
 * репозитории и не выводится из токена бота на проде.
 */
export const tgHash = (tgId: bigint) =>
  crypto.createHmac('sha256', env.deletionPepper).update(String(tgId)).digest('hex')

/* ── выгрузка ─────────────────────────────────────────────── */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

/**
 * Всё, что есть о человеке, одним объектом. Формат сознательно человекочитаемый:
 * выгрузку должен понимать сам человек, а не только программа.
 */
export async function exportMyData(tgId: bigint) {
  const [user, librarian, books, given, taken, reviews, reports, waitings, market, events] =
    await Promise.all([
      prisma.user.findUnique({ where: { tgId } }),
      prisma.librarian.findUnique({ where: { tgId } }),
      prisma.book.findMany({ where: { owner: { tgId } }, orderBy: { createdAt: 'asc' } }),
      prisma.loan.findMany({
        where: { ownerTg: tgId },
        include: { events: true },
        orderBy: { takenAt: 'asc' },
      }),
      prisma.loan.findMany({
        where: { holderTg: tgId },
        include: { events: true },
        orderBy: { takenAt: 'asc' },
      }),
      prisma.review.findMany({ where: { authorTg: tgId }, orderBy: { createdAt: 'asc' } }),
      prisma.reviewReport.findMany({ where: { reporterTg: tgId }, orderBy: { createdAt: 'asc' } }),
      prisma.waiting.findMany({ where: { userTg: tgId }, orderBy: { createdAt: 'asc' } }),
      prisma.marketItem.findMany({ where: { authorTg: tgId }, orderBy: { createdAt: 'asc' } }),
      prisma.event.findMany({ where: { createdBy: tgId }, orderBy: { createdAt: 'asc' } }),
    ])

  // ограничения и решения модераторов — тоже данные о человеке, и в выгрузке
  // им место наравне с книгами и выдачами
  const [restrictions, decisions] = await Promise.all([
    prisma.userRestriction.findMany({ where: { userTg: tgId }, orderBy: { createdAt: 'asc' } }),
    prisma.moderationAction.findMany({
      where: { targetUserTg: tgId },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  const loan = (l: (typeof given)[number], role: 'дал почитать' | 'взял почитать') => ({
    role,
    книга: l.title,
    когда_отдали: iso(l.takenAt),
    вернуть_до: iso(l.dueAt),
    когда_вернулась: iso(l.returnedAt),
    состояние: l.status,
    // ник второй стороны — тоже часть ЭТОЙ записи, человек его и так видит в приложении
    у_кого: l.holderUsername ? `@${l.holderUsername}` : l.holderName,
    события: l.events.map((e) => ({ что: e.kind, когда: iso(e.at) })),
  })

  return {
    сформировано: new Date().toISOString(),
    о_чём: 'Все данные, которые проект «МнеНеЖалко» хранит о вас.',
    профиль: user && {
      telegram_id: String(user.tgId),
      ник: user.username,
      имя: user.firstName,
      город: user.city,
      язык: user.lang,
      анонсы_встреч: user.eventAlerts,
      первый_вход: iso(user.createdAt),
      последний_вход: iso(user.seenAt),
    },
    библиотекарь: librarian && {
      имя: librarian.name,
      telegram: librarian.telegram,
      instagram: librarian.instagram,
      город: librarian.city,
      район: librarian.district,
      заведён: iso(librarian.createdAt),
      есть_в_общей_таблице: Boolean(librarian.notionId),
    },
    книги: books.map((b) => ({
      название: b.title,
      автор: b.author,
      жанры: b.genres,
      языки: b.languages,
      город: b.city,
      обложка: b.coverUrl,
      состояние: b.status,
      проверка: b.reviewStatus,
      добавлена: iso(b.createdAt),
      активна: b.active,
    })),
    выдачи: [
      ...given.map((l) => loan(l, 'дал почитать')),
      ...taken.map((l) => loan(l, 'взял почитать')),
    ],
    отзывы: reviews.map((r) => ({
      произведение: r.workKey,
      оценка: r.rating,
      текст: r.text,
      состояние: r.status,
      жалоб: r.reports,
      когда: iso(r.createdAt),
    })),
    мои_жалобы_на_отзывы: reports.map((r) => ({ отзыв: r.reviewId, когда: iso(r.createdAt) })),
    очереди_на_книги: waitings.map((w) => ({
      книга: w.bookId,
      состояние: w.status,
      встал: iso(w.createdAt),
    })),
    объявления_барахолки: market.map((m) => ({
      заголовок: m.title,
      город: m.city,
      состояние: m.status,
      когда: iso(m.createdAt),
    })),
    встречи: events.map((e) => ({ название: e.title, когда: iso(e.startsAt) })),
    ограничения_и_модерация: {
      состояние_аккаунта: user?.accountStatus ?? 'нет профиля',
      заблокирован: user?.accountStatus === 'banned',
      причина_блокировки: user?.banReason ?? null,
      когда_заблокирован: iso(user?.bannedAt),
      ограничения: restrictions.map((r) => ({
        что_закрыто: r.scope,
        причина: r.reason,
        поставлено: iso(r.createdAt),
        действует_до: iso(r.expiresAt),
        снято: iso(r.liftedAt),
      })),
      // кто именно из админов принял решение, наружу не отдаём: это данные о
      // модераторе, а не о вас
      решения_по_мне: decisions.map((a) => ({
        что: a.action,
        к_чему: a.targetType,
        причина: a.reason,
        когда: iso(a.createdAt),
      })),
    },
  }
}

/**
 * Вычищает из свободного текста имя, ник и id человека.
 *
 * Причину ограничения модератор пишет руками, и «спам от @vasya» после удаления
 * данных Васи хранить нельзя. Полностью текст не выбрасываем: без него журнал
 * решений перестаёт что-либо объяснять.
 */
export function scrubPersonal(text: string, identifiers: string[]): string {
  let out = text
  for (const id of identifiers) {
    if (!id) continue
    const safe = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`@?${safe}`, 'gi'), ERASED_NAME)
  }
  return out
}

/* ── удаление ─────────────────────────────────────────────── */

export type DeletionBlock = {
  error: 'active_loans'
  /** незакрытые выдачи, из-за которых удаление сейчас невозможно */
  loans: { title: string; role: 'дали почитать' | 'взяли почитать' }[]
}

export type DeletionResult = {
  summary: {
    книг_скрыто: number
    выдач_анонимизировано: number
    отзывов_удалено: number
    жалоб_удалено: number
    очередей_удалено: number
    /** чужие ожидания ВАШИХ книг: людям сообщаем, что книги больше нет */
    чужих_ожиданий_закрыто: number
    объявлений_удалено: number
    фотографий_удалено: number
  }
  /** что произойдёт, человеческим языком — показывается до нажатия кнопки */
  effects: string[]
}

/** Незакрытые выдачи человека — с любой стороны. */
export async function openLoansOf(tgId: bigint) {
  return prisma.loan.findMany({
    where: { status: 'active', OR: [{ ownerTg: tgId }, { holderTg: tgId }] },
    select: { id: true, title: true, ownerTg: true },
  })
}

/**
 * Удаляет данные человека. Возвращает либо сводку, либо причину отказа.
 *
 * @param dryRun посчитать, но ничего не менять — для экрана «что будет удалено»
 */
export async function deleteMyData(
  tgId: bigint,
  opts: { dryRun?: boolean } = {},
): Promise<DeletionResult | DeletionBlock> {
  const open = await openLoansOf(tgId)
  if (open.length) {
    return {
      error: 'active_loans',
      loans: open.map((l) => ({
        title: l.title,
        role: l.ownerTg === tgId ? ('дали почитать' as const) : ('взяли почитать' as const),
      })),
    }
  }

  const librarian = await prisma.librarian.findUnique({ where: { tgId } })
  const books = librarian
    ? await prisma.book.findMany({ where: { ownerId: librarian.id } })
    : []
  const reviews = await prisma.review.findMany({ where: { authorTg: tgId } })
  const [reportCount, waitingCount, marketCount, loanCount] = await Promise.all([
    prisma.reviewReport.count({ where: { reporterTg: tgId } }),
    prisma.waiting.count({ where: { userTg: tgId } }),
    prisma.marketItem.count({ where: { authorTg: tgId } }),
    prisma.loan.count({ where: { OR: [{ ownerTg: tgId }, { holderTg: tgId }] } }),
  ])

  // свои фотографии обложек: чужие ссылки (livelib и прочие) трогать нечего
  const ownPhotos = books
    .map((b) => b.coverUrl)
    .filter((u): u is string => Boolean(u && u.includes('/api/cover/')))
    .map((u) => u.split('/api/cover/')[1]!.split('?')[0]!)

  // люди, которые ждут ВАШИ книги: их обещание умрёт вместе с полкой, и они
  // должны об этом узнать, а не ждать письма, которое уже не придёт
  const bookIds = books.map((b) => b.id)
  const strangersWaiting = bookIds.length
    ? await prisma.waiting.findMany({
        where: { bookId: { in: bookIds }, status: { in: ['waiting', 'ready'] }, userTg: { not: tgId } },
        include: { book: { select: { title: true } } },
      })
    : []

  const summary: DeletionResult['summary'] = {
    книг_скрыто: books.length,
    выдач_анонимизировано: loanCount,
    отзывов_удалено: reviews.length,
    жалоб_удалено: reportCount,
    очередей_удалено: waitingCount,
    чужих_ожиданий_закрыто: strangersWaiting.length,
    объявлений_удалено: marketCount,
    фотографий_удалено: ownPhotos.length,
  }

  // словами, а не только числами: «7 книг» человек прочтёт как «7 удалили», а
  // на самом деле книги остаются у него дома и просто уходят из каталога
  const effects = [
    books.length
      ? `Ваши ${books.length} ${plural(books.length, ['книга снимется', 'книги снимутся', 'книг снимутся'])} с полки и перестанут показываться в каталоге. Сами книги, конечно, остаются у вас.`
      : '',
    strangersWaiting.length
      ? `${strangersWaiting.length} ${plural(strangersWaiting.length, ['человек, который ждал', 'человека, которые ждали', 'человек, которые ждали'])} ваши книги, получит сообщение, что книга больше недоступна.`
      : '',
    reviews.length ? 'Ваши оценки и отзывы будут удалены.' : '',
    loanCount
      ? 'Записи о прошлых обменах останутся в истории проекта, но узнать в них вас будет нельзя.'
      : '',
    'Профиль, ник, имя и город удаляются полностью.',
  ].filter(Boolean)

  if (opts.dryRun) return { summary, effects }

  const workKeys = [...new Set(reviews.map((r) => r.workKey))]

  // по этим строкам чистим свободный текст модераторов: там мог оказаться ник
  // или имя человека, а обещание «удалим данные» распространяется и на них
  const me = await prisma.user.findUnique({ where: { tgId } })
  const identifiers = [String(tgId), me?.username ?? '', me?.firstName ?? '', librarian?.name ?? '']
    .map((x) => x.trim())
    .filter((x) => x.length >= 3)

  await prisma.$transaction(async (tx) => {
    // 1. только его: очереди, жалобы, отзывы, объявления
    await tx.waiting.deleteMany({ where: { userTg: tgId } })
    await tx.reviewReport.deleteMany({ where: { reporterTg: tgId } })
    await tx.review.deleteMany({ where: { authorTg: tgId } })
    await tx.marketItem.deleteMany({ where: { authorTg: tgId } })
    // средняя оценка произведения не должна помнить удалённый отзыв
    for (const workKey of workKeys) {
      const rows = await tx.review.findMany({ where: { workKey, status: 'visible' } })
      if (!rows.length) {
        await tx.workRating.deleteMany({ where: { workKey } })
        continue
      }
      const sum = rows.reduce((acc, r) => acc + r.rating, 0)
      await tx.workRating.update({ where: { workKey }, data: { count: rows.length, sum } })
    }

    // 2. книги уходят с полки: человек покидает проект, его книги брать не у кого.
    //    Книга без владельца не должна ни висеть в каталоге, ни числиться
    //    свободной, ни собирать новых людей в очередь
    if (librarian) {
      await tx.book.updateMany({
        where: { ownerId: librarian.id },
        data: {
          active: false,
          reviewStatus: 'deleted',
          deletedAt: new Date(),
          status: 'free',
          coverUrl: null,
          notionArchivePending: true,
        },
      })
      // очереди на эти книги закрываем здесь же: обещание «сообщим, когда
      // освободится» больше некому исполнять
      for (const bookId of bookIds) await closeWaitlist(tx, bookId)
    }

    // 3. история обмена остаётся, человек в ней исчезает
    await tx.loan.updateMany({ where: { ownerTg: tgId }, data: { ownerTg: null } })
    await tx.loan.updateMany({
      where: { holderTg: tgId },
      data: { holderTg: null, holderUsername: null, holderName: ERASED_NAME },
    })
    await tx.loanEvent.updateMany({ where: { byTg: tgId }, data: { byTg: null } })

    // 4. следы в служебных полях книг и отзывов
    await tx.book.updateMany({ where: { addedByTg: tgId }, data: { addedByTg: null } })
    await tx.book.updateMany({ where: { reviewedByTg: tgId }, data: { reviewedByTg: null } })
    await tx.book.updateMany({ where: { deletedByTg: tgId }, data: { deletedByTg: null } })
    await tx.book.updateMany({
      where: { approvalStartedByTg: tgId },
      data: { approvalStartedByTg: null },
    })
    await tx.review.updateMany({ where: { hiddenByTg: tgId }, data: { hiddenByTg: null } })
    await tx.event.updateMany({ where: { createdBy: tgId }, data: { createdBy: null } })

    // 5. карточка библиотекаря обезличивается, но не удаляется: на неё ссылаются
    //    книги, а на книги — закрытые выдачи. Имя и все контакты уходят
    if (librarian) {
      await tx.librarian.update({
        where: { id: librarian.id },
        data: {
          name: ERASED_NAME,
          telegram: null,
          telegramNorm: null,
          instagram: null,
          city: null,
          district: null,
          tgId: null,
          telegramSyncPending: false,
        },
      })
    }

    // 6. журнал модерации: сам факт решения в истории остаётся (иначе нельзя
    //    объяснить, почему что-то было скрыто), но человек в нём исчезает.
    //    Вместо id — тот же отпечаток HMAC, что и в журнале удалений: сверить
    //    «то же ли это лицо» можно, восстановить id нельзя
    const hash = tgHash(tgId)
    const mine = await tx.moderationAction.findMany({
      where: { OR: [{ targetUserTg: tgId }, { actorTg: tgId }] },
    })
    for (const a of mine) {
      await tx.moderationAction.update({
        where: { id: a.id },
        data: {
          targetUserTg: a.targetUserTg === tgId ? null : a.targetUserTg,
          targetHash: a.targetUserTg === tgId ? hash : a.targetHash,
          actorTg: a.actorTg === tgId ? null : a.actorTg,
          actorHash: a.actorTg === tgId ? hash : a.actorHash,
          // причину и подробности пишет человек руками: там могли оказаться имя
          // и ник, и после обещания «удалим» им там не место
          reason: scrubPersonal(a.reason, identifiers),
          meta: a.meta ? scrubPersonal(a.meta, identifiers) : null,
        },
      })
    }
    // письма, которые так и не ушли, после удаления отправлять некому
    await tx.notificationOutbox.deleteMany({ where: { recipientTg: tgId } })

    // 7. сам профиль
    await tx.user.deleteMany({ where: { tgId } })

    // 8. журнал удалений: только отпечаток, чтобы повторить удаление после
    //    восстановления резервной копии
    await tx.deletionRequest.upsert({
      where: { tgHash: hash },
      create: { tgHash: hash, completedAt: new Date(), summary: JSON.stringify(summary) },
      update: { completedAt: new Date(), summary: JSON.stringify(summary) },
    })
  })

  invalidateFacets()

  // ── дальше внешнее: файлы и общая таблица. Сбой здесь не отменяет удаления
  for (const file of ownPhotos) {
    await unlink(path.join(COVERS_DIR, file)).catch(() => {})
  }

  if (notionWriteEnabled()) {
    for (const b of books) {
      if (b.notionId) {
        await archiveRow(b.notionId)
          .then(() =>
            prisma.book.update({
              where: { id: b.id },
              data: { notionArchivePending: false },
            }),
          )
          .catch((e: any) =>
            console.error('[mydata] строку книги не удалось убрать из Notion:', e?.message ?? e),
          )
      }
    }
    if (librarian?.notionId) {
      // контакт из общей таблицы убираем сразу; саму строку владельца оставляем
      // архивной ссылкой для уже отданных книг
      await updateOwnerTelegram(librarian.notionId, null).catch((e: any) =>
        console.error('[mydata] контакт в Notion не очистился:', e?.message ?? e),
      )
      await archiveRow(librarian.notionId).catch((e: any) =>
        console.error('[mydata] строку владельца не удалось заархивировать:', e?.message ?? e),
      )
    }
  }

  // ждавшим ваши книги — нейтральное сообщение. После транзакции: рассылка
  // ненадёжна и внешняя, а удаление уже состоялось
  if (strangersWaiting.length && bookGoneNotifier) {
    await Promise.resolve(
      bookGoneNotifier(
        strangersWaiting.map((w) => ({ userTg: w.userTg, title: w.book.title })),
      ),
    ).catch((e: any) => console.error('[mydata] не удалось сообщить ждавшим:', e?.message ?? e))
  }

  return { summary, effects }
}

/**
 * Повторное применение журнала: после восстановления старой резервной копии в
 * базе снова появляются данные тех, кто просил их удалить.
 *
 * Зовётся вручную (`npm run privacy:reapply -w server`) сразу после восстановления.
 */
export async function reapplyDeletions(log = console.log): Promise<{ found: number; erased: number }> {
  const journal = await prisma.deletionRequest.findMany({ select: { tgHash: true } })
  const hashes = new Set(journal.map((r) => r.tgHash))
  if (!hashes.size) return { found: 0, erased: 0 }

  const users = await prisma.user.findMany({ select: { tgId: true } })
  let erased = 0
  for (const u of users) {
    if (!hashes.has(tgHash(u.tgId))) continue
    log(`[privacy] в восстановленной базе снова есть удалённый человек — удаляю повторно`)
    const r = await deleteMyData(u.tgId)
    if ('error' in r) {
      log(`[privacy] ⚠️ повторное удаление отложено: ${r.error} (${r.loans.length} незакрытых выдач)`)
      continue
    }
    erased++
  }
  return { found: hashes.size, erased }
}
