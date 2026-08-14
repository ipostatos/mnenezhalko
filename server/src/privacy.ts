/**
 * Приватность контактов (этап 9.2).
 *
 * Решение продукта (user, 2026-07-25): КАТАЛОГ остаётся публичным — книги и так
 * лежат в открытом Notion проекта, — но КОНТАКТЫ (Telegram-ник библиотекаря,
 * инстаграм, ник автора объявления) отдаются только запросу с валидной подписью
 * Telegram, то есть из самого Mini App. До этого `GET /api/books` и
 * `GET /api/librarians/:id` без всякой авторизации отдавали весь список
 * библиотекарей вместе с их никами — то есть базу контактов можно было выкачать
 * одним curl и залить в спам-рассылку.
 *
 * Отдельно и строже: числовой `tgId` (authorTg у объявлений, createdBy у встреч)
 * НЕ уходит клиенту вообще, даже подписанному. Клиенту он не нужен ни для чего:
 * писать человеку можно только по @нику, а по числовому id бот может писать
 * первым — это внутренний идентификатор, а не контакт.
 *
 * Функции ничего не знают о Fastify: на входе данные, на выходе данные —
 * поэтому проверяются юнит-тестами без сети (privacy.test.ts).
 */

/** Контактные поля владельца книги/библиотекаря. */
const OWNER_CONTACTS = ['telegram', 'instagram'] as const

type MaybeOwner = Record<string, any> | null | undefined

/**
 * Прячет контакты владельца. `allowed` — есть ли валидная подпись Telegram.
 * Поля не удаляются, а становятся `null`: у клиента типы `string | null`, и
 * условие `owner.telegram && …` в UI просто не покажет кнопку «Написать».
 * Удаление ключей заставило бы фронт различать «нет ника» и «ник скрыт», хотя
 * ведёт он себя в обоих случаях одинаково.
 */
export function redactOwner<T extends MaybeOwner>(owner: T, allowed: boolean): T {
  if (!owner || allowed) return owner
  const copy: Record<string, any> = { ...owner }
  for (const f of OWNER_CONTACTS) if (f in copy) copy[f] = null
  return copy as T
}

/** То же для карточки книги (контакты лежат в `card.owner`). */
export function redactCard<T extends Record<string, any>>(card: T, allowed: boolean): T {
  if (allowed || !card?.owner) return card
  return { ...card, owner: redactOwner(card.owner, allowed) }
}

export function redactCards<T extends Record<string, any>>(cards: T[], allowed: boolean): T[] {
  if (allowed) return cards
  return cards.map((c) => redactCard(c, allowed))
}

/**
 * Объявление барахолки: `authorTg` (числовой id) снимается ВСЕГДА, `authorUsername`
 * — только для подписанных. Раньше `GET /api/market` отдавал сырые строки таблицы,
 * то есть id и ники всех, кто когда-либо писал в барахолку.
 */
export function redactMarketItem<T extends Record<string, any>>(item: T, allowed: boolean): Omit<T, 'authorTg'> {
  const { authorTg: _drop, ...rest } = item as Record<string, any>
  if (!allowed && 'authorUsername' in rest) rest.authorUsername = null
  return rest as Omit<T, 'authorTg'>
}

/**
 * Выдача наружу: белый список полей вместо строки базы целиком.
 *
 * Здесь именно белый список, а не «выкинем лишнее»: ручка выдач единственная,
 * где данные видит подписанный человек, и на этом её и пропустили — наружу
 * уезжали числовые id обеих сторон, хэш claim-токена (он же ключ от чужой
 * выдачи) и приватная заметка владельца, которую читателю видеть незачем
 * (аудит 14.08.2026). При добавлении нового поля в модель Loan оно теперь
 * НЕ попадает клиенту само собой — это и есть смысл белого списка.
 *
 * Роль в выдаче считает сервер и отдаёт готовой: клиенту незачем сравнивать
 * числовые id, чтобы понять, его это книга или чужая.
 */
export function publicLoan<
  T extends {
    id: string
    title: string
    bookId?: string | null
    book?: { id: string; title: string; coverUrl: string | null } | null
    holderUsername?: string | null
    holderName?: string | null
    status: string
    takenAt: Date
    dueAt?: Date | null
    returnedAt?: Date | null
  },
>(loan: T, extra: Record<string, unknown> = {}) {
  return {
    id: loan.id,
    title: loan.title,
    bookId: loan.bookId ?? null,
    book: loan.book ?? null,
    holderUsername: loan.holderUsername ?? null,
    holderName: loan.holderName ?? null,
    status: loan.status,
    takenAt: loan.takenAt,
    dueAt: loan.dueAt ?? null,
    returnedAt: loan.returnedAt ?? null,
    ...extra,
  }
}

/** Встреча: `createdBy` — числовой tgId администратора, клиенту не нужен никогда. */
export function redactEvent<T extends Record<string, any>>(event: T): Omit<T, 'createdBy'> {
  const { createdBy: _drop, ...rest } = event as Record<string, any>
  return rest as Omit<T, 'createdBy'>
}
