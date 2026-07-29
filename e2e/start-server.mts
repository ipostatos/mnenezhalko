/**
 * Запуск сервера для сквозных проверок: сначала чистая база, потом само
 * приложение — в одном процессе, чтобы порядок был гарантирован.
 *
 * База создаётся МИГРАЦИЯМИ, а не `db push`: сквозной прогон заодно проверяет,
 * что цепочка миграций даёт работающее приложение, а не только совпадает со
 * схемой (тесты сервера поднимают базу по итоговой схеме и этого не заметят).
 */
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverDir = resolve(here, '../server')
const dbFile = resolve(serverDir, 'data/e2e.db')

mkdirSync(dirname(dbFile), { recursive: true })
for (const suffix of ['', '-journal', '-wal', '-shm']) {
  rmSync(`${dbFile}${suffix}`, { force: true })
}

execSync('npx prisma migrate deploy', {
  cwd: serverDir,
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
})

// справочник жанров и языков кладём заранее: иначе на старте приложение
// пошло бы за ним в Notion, и сквозной прогон зависел бы от сети и от того,
// что сейчас в таблице проекта
const { prisma } = await import('../server/src/db.ts')
const { TAXONOMY_KEY, FALLBACK_GENRES, FALLBACK_LANGUAGES } = await import(
  '../server/src/taxonomy.ts'
)
await prisma.syncState.upsert({
  where: { key: TAXONOMY_KEY },
  create: {
    key: TAXONOMY_KEY,
    value: JSON.stringify({ genres: FALLBACK_GENRES, languages: FALLBACK_LANGUAGES }),
  },
  update: {},
})

await import('../server/src/index.ts')
