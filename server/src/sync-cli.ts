import { prisma } from './db.js'
import { syncFromNotion } from './sync.js'
import { seedCityGroups } from './seed.js'

const report = await syncFromNotion()
await seedCityGroups()
console.table(report)

const [books, games, librarians, cities] = await Promise.all([
  prisma.book.count({ where: { kind: 'book', active: true } }),
  prisma.book.count({ where: { kind: 'game', active: true } }),
  prisma.librarian.count(),
  prisma.book.groupBy({ by: ['city'], _count: true, where: { active: true } }),
])
console.log({ books, games, librarians })
console.log(
  cities
    .filter((c) => c.city)
    .sort((a, b) => b._count - a._count)
    .map((c) => `${c.city}: ${c._count}`)
    .join('\n'),
)
await prisma.$disconnect()
