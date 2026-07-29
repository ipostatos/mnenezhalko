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
import { prisma } from './db.js'
import { reapplyDeletions } from './mydata.js'

const r = await reapplyDeletions()
console.log(
  `[privacy] в журнале удалений записей: ${r.found}; удалено повторно в этой базе: ${r.erased}`,
)
await prisma.$disconnect()
