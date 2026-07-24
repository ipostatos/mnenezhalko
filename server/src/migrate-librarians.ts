/**
 * Разовая миграция целостности библиотекарей (issue #1).
 *
 *   npm run migrate:librarians -w server -- --dry   # показать, ничего не меняя
 *   npm run migrate:librarians -w server             # выполнить слияние
 *
 * Что делает:
 *   1) добивает telegramNorm там, где он ещё пуст;
 *   2) группирует не-архивные записи по нормализованному нику;
 *   3) в каждой группе дублей выбирает главную (с notionId → останется в синке),
 *      переносит на неё все книги, привязывает tgId, а дубли помечает
 *      mergedIntoId (не удаляет физически — на них могут ссылаться история/статистика).
 *
 * Безопасность: если в группе несколько РАЗНЫХ живых tgId — это разные люди с
 * похожим ником, группа пропускается и попадает в отчёт для ручной проверки.
 * Идемпотентно: архивные записи (mergedIntoId != null) в следующий прогон не берутся.
 */
import { prisma } from './db.js'
import { normHandle } from './notion.js'
import { pickPrimary } from './librarian.js'

async function main() {
  const dry = process.argv.includes('--dry')

  // 1. добить telegramNorm
  const needNorm = await prisma.librarian.findMany({
    where: { telegramNorm: null, telegram: { not: null } },
    select: { id: true, telegram: true },
  })
  let normed = 0
  for (const l of needNorm) {
    const n = normHandle(l.telegram)
    if (!n) continue
    if (!dry) await prisma.librarian.update({ where: { id: l.id }, data: { telegramNorm: n } })
    normed++
  }
  // в dry-режиме telegramNorm ещё не проставлен — считаем ключ на лету ниже

  // 2. группируем не-архивные записи по нику
  const libs = await prisma.librarian.findMany({ where: { mergedIntoId: null } })
  const groups = new Map<string, typeof libs>()
  for (const l of libs) {
    const key = l.telegramNorm ?? normHandle(l.telegram)
    if (!key) continue
    const arr = groups.get(key) ?? []
    arr.push(l)
    groups.set(key, arr)
  }

  let mergedGroups = 0
  let booksMoved = 0
  let skipped = 0
  const skippedKeys: string[] = []

  for (const [key, group] of groups) {
    if (group.length < 2) continue

    // разные живые tgId → разные люди, не сливаем
    const tgIds = new Set(group.filter((g) => g.tgId != null).map((g) => String(g.tgId)))
    if (tgIds.size > 1) {
      skipped++
      skippedKeys.push(key)
      continue
    }

    const primary = pickPrimary(group)
    const others = group.filter((g) => g.id !== primary.id)
    const otherIds = others.map((o) => o.id)
    const tgId = group.find((g) => g.tgId != null)?.tgId ?? null

    const cnt = await prisma.book.count({ where: { ownerId: { in: otherIds } } })

    if (dry) {
      console.log(
        `[dry] ${key}: главная ${primary.id}${primary.notionId ? ' (Notion)' : ''}, ` +
          `сольются ${others.length}, книг перенесётся ${cnt}, tgId→${tgId ?? '—'}`,
      )
      mergedGroups++
      booksMoved += cnt
      continue
    }

    await prisma.$transaction(async (tx) => {
      // книги — на главную
      const mv = await tx.book.updateMany({
        where: { ownerId: { in: otherIds } },
        data: { ownerId: primary.id },
      })
      booksMoved += mv.count

      // сначала снять tgId с дублей (он @unique), затем отдать главной
      for (const o of others) {
        await tx.librarian.update({
          where: { id: o.id },
          data: { tgId: null, mergedIntoId: primary.id },
        })
      }

      const pdata: Record<string, unknown> = {}
      if (!primary.tgId && tgId != null) pdata.tgId = tgId
      if (!primary.city) pdata.city = others.find((o) => o.city)?.city ?? undefined
      if (!primary.district) pdata.district = others.find((o) => o.district)?.district ?? undefined
      if (!primary.instagram) pdata.instagram = others.find((o) => o.instagram)?.instagram ?? undefined
      if (!primary.telegramNorm) pdata.telegramNorm = key
      if (Object.keys(pdata).length) {
        await tx.librarian.update({ where: { id: primary.id }, data: pdata })
      }
    })
    mergedGroups++
  }

  const activeAfter = await prisma.librarian.count({ where: { mergedIntoId: null } })
  const booksTotal = await prisma.book.count()

  console.log(`\nОтчёт${dry ? ' (DRY-RUN, изменений нет)' : ''}:`)
  console.log(`  telegramNorm добито: ${normed}`)
  console.log(`  групп дублей ${dry ? 'к слиянию' : 'слито'}: ${mergedGroups}`)
  console.log(`  книг ${dry ? 'к переносу' : 'перенесено'}: ${booksMoved}`)
  console.log(
    `  групп пропущено (разные tgId — проверить руками): ${skipped}` +
      (skippedKeys.length ? ` — ${skippedKeys.join(', ')}` : ''),
  )
  console.log(`  активных библиотекарей после: ${activeAfter}`)
  console.log(`  всего книг в базе (не должно меняться): ${booksTotal}`)
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
