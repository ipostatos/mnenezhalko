/**
 * Notion sync circuit breaker (stage 7 текущего аудита) — полнота реализации,
 * не только «функция существует». Своя временная SQLite-база, никакой
 * реальной сети (fetchBooks/fetchGames/fetchLibrarians инжектируются).
 * Запуск: npm run test -w server
 */
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `sync-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'
process.env.NOTION_TOKEN_V2 = '' // notionWriteEnabled()=false — flushPending/flushTelegramUpdates не трогают сеть

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { syncFromNotion, deactivationGuard, setSyncAlert, nextSyncDelayMs, retryDelayMs, SYNC_BOOT_DELAY_MS, SYNC_RETRY_BASE_MS } =
  await import('./sync.js')

after(async () => {
  await prisma.$disconnect()
  unlinkSync(DB_FILE)
})

// deactivationGuard считает по ВСЕЙ таблице для данного kind — без чистки
// между тестами данные одного теста искажали бы проценты в следующем.
beforeEach(async () => {
  await prisma.loanEvent.deleteMany()
  await prisma.loan.deleteMany()
  await prisma.book.deleteMany()
  await prisma.librarian.deleteMany()
  await prisma.user.deleteMany()
  await prisma.syncState.deleteMany()
})

function silentLog() {}

/** Фейковый минимальный NotionBook — только то, что реально читает sync.ts. */
function fakeBook(notionId: string, overrides: Partial<Record<string, any>> = {}) {
  return {
    notionId,
    kind: 'book' as const,
    title: overrides.title ?? `Книга ${notionId}`,
    author: null,
    genres: '',
    languages: '',
    coverUrl: null,
    status: 'free',
    addedAt: null,
    ownerNotionId: overrides.ownerNotionId ?? null,
    city: overrides.city ?? null,
    district: null,
  }
}

function fakeLibrarian(notionId: string, name = notionId) {
  return { notionId, name, telegram: null, instagram: null, city: null, district: null }
}

/** Существующие активные книги «из прошлого синка» — то, что до этого прогона уже в базе. */
async function seedExistingBooks(n: number, kind: 'book' | 'game' = 'book') {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const notionId = randomUUID()
    await prisma.book.create({
      data: { notionId, title: `Существующая ${i}`, kind, source: 'notion', active: true, reviewStatus: 'approved' },
    })
    ids.push(notionId)
  }
  return ids
}

function deps(books: any[] = [], games: any[] = [], librarians: any[] = []) {
  return {
    fetchBooks: async () => books,
    fetchGames: async () => games,
    fetchLibrarians: async () => librarians,
    // справочник жанров живёт в Notion — в тестах в сеть не ходим
    refreshTaxonomy: async () => ({}),
  }
}

async function syncState() {
  return prisma.syncState.findUnique({ where: { key: 'notion' } })
}

test('нормальный синк: ничего не пропало, baseline продвигается', async () => {
  const ids = await seedExistingBooks(25)
  const books = ids.map((id) => fakeBook(id))
  const r = await syncFromNotion(silentLog, deps(books))
  assert.equal(r.deactivated, 0)
  assert.equal(r.suspicious, false)
  const state = await syncState()
  assert.ok(state, 'baseline должен появиться после честного синка')
})

test('удалена одна книга из большой библиотеки — деактивируется штатно, не подозрительно', async () => {
  const ids = await seedExistingBooks(25)
  const books = ids.slice(1).map((id) => fakeBook(id)) // одной не хватает
  const r = await syncFromNotion(silentLog, deps(books))
  assert.equal(r.deactivated, 1)
  assert.equal(r.suspicious, false)
  const gone = await prisma.book.findFirst({ where: { notionId: ids[0] } })
  assert.equal(gone?.active, false)
})

test('падение на 5% — ниже порога, деактивируется штатно', async () => {
  const ids = await seedExistingBooks(100)
  const books = ids.slice(5).map((id) => fakeBook(id)) // 5 из 100 пропало
  const r = await syncFromNotion(silentLog, deps(books))
  assert.equal(r.deactivated, 5)
  assert.equal(r.suspicious, false)
})

test('падение на 50% — предохранитель срабатывает, деактивация пропущена, baseline не продвигается', async () => {
  const ids = await seedExistingBooks(40)
  const books = ids.slice(20).map((id) => fakeBook(id)) // половины не хватает
  const before = await syncState()
  const r = await syncFromNotion(silentLog, deps(books))
  assert.equal(r.deactivated, 0, 'ни одна книга не должна быть скрыта')
  assert.equal(r.suspicious, true)
  const stillActive = await prisma.book.count({ where: { notionId: { in: ids }, active: true } })
  assert.equal(stillActive, 40, 'все 40 книг должны остаться активными')
  const after = await syncState()
  assert.equal(after, before, 'baseline не должен был сдвинуться')
  assert.equal(after, null, 'в этом тесте до синка baseline не было вовсе')
})

test('пустой ответ (0 книг) не деактивирует всю библиотеку', async () => {
  const ids = await seedExistingBooks(30)
  const r = await syncFromNotion(silentLog, deps([]))
  assert.equal(r.deactivated, 0)
  assert.equal(r.suspicious, true)
  const stillActive = await prisma.book.count({ where: { notionId: { in: ids }, active: true } })
  assert.equal(stillActive, 30)
})

test('books успешно, games с ошибкой: books обрабатывается штатно, games не трогаем вовсе', async () => {
  const bookIds = await seedExistingBooks(25, 'book')
  const gameIds = await seedExistingBooks(25, 'game')
  const books = bookIds.slice(1).map((id) => fakeBook(id)) // одна книга пропала — штатно
  const failingGames = { fetchGames: async () => { throw new Error('notion games API упал') } }
  const r = await syncFromNotion(silentLog, { ...deps(books, []), ...failingGames })

  assert.equal(r.deactivated, 1, 'книги должны были деактивироваться как обычно')
  const goneBook = await prisma.book.findFirst({ where: { notionId: bookIds[0] } })
  assert.equal(goneBook?.active, false)

  const gamesStillActive = await prisma.book.count({ where: { notionId: { in: gameIds }, active: true } })
  assert.equal(gamesStillActive, 25, 'ни одна настолка не должна была деактивироваться — источник упал')

  const state = await syncState()
  assert.equal(state, null, 'baseline не должен продвигаться, если хоть один источник упал')
})

test('повтор после suspicious: следующий честный синк восстанавливает штатное состояние', async () => {
  const ids = await seedExistingBooks(40)
  await syncFromNotion(silentLog, deps(ids.slice(20).map((id) => fakeBook(id)))) // suspicious
  const afterSuspicious = await syncState()
  assert.equal(afterSuspicious, null)

  // теперь честный повтор: реально пропала только 1 книга из 40
  const r2 = await syncFromNotion(silentLog, deps(ids.slice(1).map((id) => fakeBook(id))))
  assert.equal(r2.suspicious, false)
  assert.equal(r2.deactivated, 1)
  const afterRecovery = await syncState()
  assert.ok(afterRecovery, 'baseline должен появиться после честного повтора')
})

test('первый синк без baseline (пустая база) — не считается подозрительным', async () => {
  const r = await syncFromNotion(silentLog, deps([fakeBook(randomUUID())]))
  assert.equal(r.suspicious, false)
  assert.equal(r.deactivated, 0)
  const state = await syncState()
  assert.ok(state)
})

test('изменение порога через env: явные min/pct меняют решение guard', async () => {
  // тот же 20%-разрыв: по дефолту (15%) — suspicious; с порогом 25% — не suspicious
  assert.equal(deactivationGuard(100, 20).skip, true)
  assert.equal(deactivationGuard(100, 20, 20, 0.25).skip, false)
  // порог объёма: при min=200 та же выборка слишком мала, чтобы вообще сработать guard
  assert.equal(deactivationGuard(100, 20, 200, 0.15).skip, false)
})

test('уведомление администратору вызывается ровно один раз на подозрительный синк', async () => {
  const ids = await seedExistingBooks(40)
  let calls = 0
  setSyncAlert(() => {
    calls++
  })
  try {
    await syncFromNotion(silentLog, deps(ids.slice(20).map((id) => fakeBook(id))))
  } finally {
    setSyncAlert(() => {})
  }
  assert.equal(calls, 1)
})

test('bot-added книги не затрагиваются синком вообще', async () => {
  const bot = await prisma.book.create({
    data: { title: 'Добавлена ботом', source: 'bot', active: true, reviewStatus: 'approved' },
  })
  // Notion вообще не знает об этой книге (notionId=null) — синк идёт по книгам из Notion
  await syncFromNotion(silentLog, deps([fakeBook(randomUUID())]))
  const fresh = await prisma.book.findUniqueOrThrow({ where: { id: bot.id } })
  assert.equal(fresh.active, true)
  assert.equal(fresh.source, 'bot')
})

test('merged librarian остаётся корректным владельцем — книги привязываются к главной записи', async () => {
  const primary = await prisma.librarian.create({
    data: { name: 'Главная запись', notionId: randomUUID() },
  })
  const merged = await prisma.librarian.create({
    data: { name: 'Дубль (архивный)', notionId: randomUUID(), mergedIntoId: primary.id },
  })

  const bookNotionId = randomUUID()
  const librarians = [fakeLibrarian(primary.notionId!), fakeLibrarian(merged.notionId!)]
  const books = [fakeBook(bookNotionId, { ownerNotionId: merged.notionId })]

  await syncFromNotion(silentLog, deps(books, [], librarians))

  const book = await prisma.book.findUniqueOrThrow({ where: { notionId: bookNotionId } })
  assert.equal(book.ownerId, primary.id, 'книга должна привязаться к главной записи, а не к архивному дублю')
})


// ── источники истины: синк не портит локальные данные (аудит 2026-07-28, P0.2) ──
// См. docs/DATA_OWNERSHIP.md. До фикса upsert слепо перезаписывал всё из Notion.

test('выданная книга остаётся busy после синка (Notion шлёт free)', async () => {
  const notionId = randomUUID()
  const book = await prisma.book.create({
    data: { notionId, title: 'Выданная', kind: 'book', source: 'notion', active: true, reviewStatus: 'approved', status: 'busy' },
  })
  await prisma.user.upsert({ where: { tgId: 1n }, create: { tgId: 1n }, update: {} })
  await prisma.loan.create({
    data: { title: 'Выданная', bookId: book.id, activeBookId: book.id, ownerTg: 1n, status: 'active' },
  })
  await syncFromNotion(silentLog, deps([fakeBook(notionId)])) // status: 'free' из Notion
  const fresh = await prisma.book.findUniqueOrThrow({ where: { id: book.id } })
  assert.equal(fresh.status, 'busy', 'активная выдача — источник истины для статуса')
})

test('после возврата следующий синк НЕ возвращает книгу в busy', async () => {
  const notionId = randomUUID()
  const book = await prisma.book.create({
    data: { notionId, title: 'Вернулась', kind: 'book', source: 'notion', active: true, reviewStatus: 'approved', status: 'free' },
  })
  await prisma.user.upsert({ where: { tgId: 1n }, create: { tgId: 1n }, update: {} })
  await prisma.loan.create({
    data: { title: 'Вернулась', bookId: book.id, ownerTg: 1n, status: 'returned', returnedAt: new Date() },
  })
  await syncFromNotion(silentLog, deps([fakeBook(notionId)]))
  const fresh = await prisma.book.findUniqueOrThrow({ where: { id: book.id } })
  assert.equal(fresh.status, 'free')
})

test('локальный город книги не затирается пустым значением из Notion', async () => {
  const notionId = randomUUID()
  await prisma.book.create({
    data: { notionId, title: 'С городом', kind: 'book', source: 'notion', active: true, reviewStatus: 'approved', city: 'Warszawa', district: 'Wola' },
  })
  await syncFromNotion(silentLog, deps([fakeBook(notionId, { city: null })]))
  const fresh = await prisma.book.findUniqueOrThrow({ where: { notionId } })
  assert.equal(fresh.city, 'Warszawa')
  assert.equal(fresh.district, 'Wola')
})

test('непустой город из Notion применяется (правки уезжают в Notion — он свежее)', async () => {
  const notionId = randomUUID()
  await prisma.book.create({
    data: { notionId, title: 'Переехала', kind: 'book', source: 'notion', active: true, reviewStatus: 'approved', city: 'Warszawa' },
  })
  await syncFromNotion(silentLog, deps([fakeBook(notionId, { city: 'Kraków' })]))
  const fresh = await prisma.book.findUniqueOrThrow({ where: { notionId } })
  assert.equal(fresh.city, 'Kraków')
})

test('город библиотекаря не затирается пустым City из Notion', async () => {
  const libNotionId = randomUUID()
  await prisma.librarian.create({
    data: { notionId: libNotionId, name: 'С городом', city: 'Warszawa', district: 'Wola' },
  })
  await syncFromNotion(silentLog, deps([], [], [fakeLibrarian(libNotionId, 'С городом')])) // city: null
  const fresh = await prisma.librarian.findUniqueOrThrow({ where: { notionId: libNotionId } })
  assert.equal(fresh.city, 'Warszawa', 'backfill-город должен пережить пустое City из Notion')
  assert.equal(fresh.district, 'Wola')
})

test('addedAt не обнуляется, когда Notion не прислал дату', async () => {
  const notionId = randomUUID()
  const added = new Date('2026-05-01T00:00:00Z')
  await prisma.book.create({
    data: { notionId, title: 'Настолка', kind: 'game', source: 'notion', active: true, reviewStatus: 'approved', addedAt: added },
  })
  await syncFromNotion(silentLog, deps([], [{ ...fakeBook(notionId), kind: 'game' }]))
  const fresh = await prisma.book.findUniqueOrThrow({ where: { notionId } })
  assert.equal(fresh.addedAt?.getTime(), added.getTime())
})

test('удалённая книга не воскресает, даже если строка осталась в Notion', async () => {
  const notionId = randomUUID()
  await prisma.book.create({
    data: {
      notionId,
      title: 'Удалённая',
      kind: 'book',
      source: 'notion',
      active: false,
      reviewStatus: 'deleted',
      deletedAt: new Date(),
    },
  })
  await syncFromNotion(silentLog, deps([fakeBook(notionId)]))
  const fresh = await prisma.book.findUniqueOrThrow({ where: { notionId } })
  assert.equal(fresh.active, false, 'tombstone: синк не воскрешает удалённое')
  assert.equal(fresh.reviewStatus, 'deleted')
})

test('второй синк не стартует, пока идёт первый', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const slow = {
    fetchBooks: async () => {
      await gate
      return []
    },
    fetchGames: async () => [],
    fetchLibrarians: async () => [],
    refreshTaxonomy: async () => ({}),
  }
  const first = syncFromNotion(silentLog, slow)
  await assert.rejects(() => syncFromNotion(silentLog, deps()), /уже идёт/)
  release()
  await first
})

// ── планирование фонового синка ────────────────────────────────────────────────
// Регрессия с прода 2026-07-25: `setInterval` отсчитывался от старта процесса,
// поэтому каждый деплой (= рестарт) сбрасывал 12-часовой отсчёт и при нескольких
// деплоях в день фоновый синк не отрабатывал НИ РАЗУ — 25 часов без синка при
// заявленных 12. Планирование должно считаться от последнего успешного синка.

const H = 3600_000

test('синк планируется от последнего успешного, а не от старта процесса', () => {
  const now = Date.parse('2026-07-25T12:00:00.000Z')
  const last = '2026-07-25T04:00:00.000Z' // 8 часов назад при периоде 12
  assert.equal(nextSyncDelayMs(last, now, 12), 4 * H, 'ждать остаток периода: 12 - 8 = 4 ч')
})

test('рестарт не съедает очередной синк: просроченный синк идёт сразу после загрузочной паузы', () => {
  const now = Date.parse('2026-07-25T12:00:00.000Z')
  const last = '2026-07-24T07:00:00.000Z' // 29 часов назад — ровно прод-случай
  assert.equal(
    nextSyncDelayMs(last, now, 12),
    SYNC_BOOT_DELAY_MS,
    'просрочка не должна ждать ещё период — синк нужен немедленно',
  )
})

test('синка никогда не было — синкаемся после загрузочной паузы, а не через 12 часов', () => {
  const now = Date.parse('2026-07-25T12:00:00.000Z')
  assert.equal(nextSyncDelayMs(null, now, 12), SYNC_BOOT_DELAY_MS)
})

test('загрузочная пауза не нулевая: на старте сначала отвечаем, потом идём в Notion', () => {
  assert.ok(SYNC_BOOT_DELAY_MS > 0)
  const now = Date.parse('2026-07-25T12:00:00.000Z')
  // даже когда синк просрочен на сутки, мгновенного удара по Notion на старте нет
  assert.ok(nextSyncDelayMs('2026-07-24T00:00:00.000Z', now, 12) >= SYNC_BOOT_DELAY_MS)
})

test('битая или будущая метка lastSync не блокирует синк навсегда', () => {
  const now = Date.parse('2026-07-25T12:00:00.000Z')
  assert.equal(nextSyncDelayMs('не дата', now, 12), SYNC_BOOT_DELAY_MS, 'битую метку игнорируем')
  assert.equal(
    nextSyncDelayMs('2026-08-01T00:00:00.000Z', now, 12),
    SYNC_BOOT_DELAY_MS,
    'метка из будущего (перевод часов/чужая запись) иначе отложила бы синк на неделю',
  )
})

test('неудачный прогон повторяется с растущей паузой, а не долбит Notion', () => {
  // неудачный и подозрительный прогоны НЕ двигают lastSync: планирование «от
  // lastSync» дало бы срок в прошлом, то есть повтор каждые 30 секунд
  assert.equal(retryDelayMs(1, 12), SYNC_RETRY_BASE_MS)
  assert.equal(retryDelayMs(2, 12), SYNC_RETRY_BASE_MS * 2)
  assert.equal(retryDelayMs(3, 12), SYNC_RETRY_BASE_MS * 4)
  assert.ok(retryDelayMs(1, 12) > SYNC_BOOT_DELAY_MS, 'повтор не должен быть чаще загрузочной паузы')
})

test('пауза повторов не превышает обычный период синка', () => {
  assert.equal(retryDelayMs(99, 12), 12 * H, 'экспонента упирается в период, а не растёт до бесконечности')
  assert.equal(retryDelayMs(99, 1), 1 * H, 'короткий период — короткий потолок')
})
