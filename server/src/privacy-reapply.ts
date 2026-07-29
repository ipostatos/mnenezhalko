/**
 * Повторное применение удалений после восстановления резервной копии.
 *
 * Копия месячной давности возвращает в базу данные тех, кто за этот месяц
 * просил их удалить. Журнал `DeletionRequest` хранит только хэши, поэтому
 * пройтись по нему и удалить этих людей ещё раз — единственный честный способ
 * не нарушить обещание.
 *
 * Запуск сразу после восстановления: `npm run privacy:reapply -w server`
 */
import { readFileSync } from 'node:fs'
import { prisma } from './db.js'
import { reapplyDeletions } from './mydata.js'

/**
 * Журнал внутри восстановленной базы сам по себе неполон: в СТАРОЙ копии нет
 * записей о тех, кто просил удаления позже её снятия. Поэтому бэкап хранит
 * журнал ещё и отдельным накопительным файлом (scripts/backup.sh), и его путь
 * можно передать сюда:
 *
 *   npm run privacy:reapply -w server -- /opt/backups/mnenezhalko/deletion-journal.csv
 */
const file = process.argv[2]
if (file) {
  const rows = readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(',')[0]!.replace(/^"|"$/g, ''))
    .filter((h) => /^[0-9a-f]{64}$/.test(h))
  let added = 0
  for (const tgHash of rows) {
    const r = await prisma.deletionRequest.upsert({
      where: { tgHash },
      create: { tgHash, completedAt: new Date(), summary: 'восстановлено из файла журнала' },
      update: {},
    })
    if (r.summary === 'восстановлено из файла журнала') added++
  }
  console.log(`[privacy] из файла ${file}: отпечатков ${rows.length}, новых для этой базы ${added}`)
}

const r = await reapplyDeletions()
console.log(
  `[privacy] в журнале удалений записей: ${r.found}; удалено повторно в этой базе: ${r.erased}`,
)
await prisma.$disconnect()
