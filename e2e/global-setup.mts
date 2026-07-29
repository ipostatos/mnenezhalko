import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Сквозные проверки идут по СОБРАННОМУ Mini App: сервер раздаёт web/dist, а не
 * dev-сборку. Без внятной подсказки падение выглядело бы как «пустая страница».
 * Саму базу готовит start-server.ts, чтобы это точно случилось до запуска.
 */
export default async function globalSetup() {
  if (!existsSync(resolve(here, '../web/dist/index.html'))) {
    throw new Error('Нет web/dist — соберите Mini App: npm run build -w web')
  }
}
