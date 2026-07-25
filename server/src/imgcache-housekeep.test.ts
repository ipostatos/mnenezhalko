/**
 * Housekeeping диска imgcache (stage 3.4 текущего аудита) — работает на
 * временной директории, реальный кэш не трогаем.
 * Запуск: npm run test -w server
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, utimes, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DISABLE_BOT = '1' // imgcache.ts тянет env.ts → нужен BOT_TOKEN без этого флага

const { housekeepImgCache, CACHE_MAX_AGE_MS, HOUSEKEEP_MIN_FILE_AGE_MS } = await import(
  './imgcache.js'
)

const dirs: string[] = []
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
})

async function tmpCacheDir() {
  const dir = await mkdtemp(join(tmpdir(), 'mnz-imgcache-'))
  dirs.push(dir)
  return dir
}

/** Пишет пару (файл + .type) и выставляет mtime на `ageMs` в прошлом от `now`. */
async function writeEntry(dir: string, name: string, size: number, ageMs: number, now: number) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), Buffer.alloc(size, 1))
  await writeFile(join(dir, `${name}.type`), 'image/webp')
  const mtime = (now - ageMs) / 1000
  await utimes(join(dir, name), mtime, mtime)
  await utimes(join(dir, `${name}.type`), mtime, mtime)
}

test('housekeeping: не трогает свежие файлы', async () => {
  const dir = await tmpCacheDir()
  const now = Date.now()
  await writeEntry(dir, 'fresh', 1000, HOUSEKEEP_MIN_FILE_AGE_MS / 2, now)

  const r = await housekeepImgCache(now, dir)
  assert.equal(r.removed, 0)
  assert.deepEqual((await readdir(dir)).sort(), ['fresh', 'fresh.type'])
})

test('housekeeping: удаляет файлы старше CACHE_MAX_AGE_MS (базу и .type парой)', async () => {
  const dir = await tmpCacheDir()
  const now = Date.now()
  await writeEntry(dir, 'stale', 1000, CACHE_MAX_AGE_MS + 3600_000, now)
  await writeEntry(dir, 'ok', 1000, CACHE_MAX_AGE_MS / 2, now)

  const r = await housekeepImgCache(now, dir)
  assert.equal(r.removed, 1)
  assert.equal(r.freedBytes, 1000)
  assert.deepEqual((await readdir(dir)).sort(), ['ok', 'ok.type'])
})

test('housekeeping: не удаляет файл младше HOUSEKEEP_MIN_FILE_AGE_MS, даже если он «в процессе записи»', async () => {
  const dir = await tmpCacheDir()
  const now = Date.now()
  // мог быть застигнут readdir прямо во время writeFile — не наш кандидат
  await writeEntry(dir, 'writing-now', 1000, 1000, now)

  const r = await housekeepImgCache(now, dir)
  assert.equal(r.removed, 0)
})

test('housekeeping: не трогает объём в пределах лимита (реальный CACHE_MAX_BYTES)', async () => {
  const dir = await tmpCacheDir()
  const now = Date.now()
  await writeEntry(dir, 'small', 400, 20 * 24 * 3600_000, now)

  // 400 байт << 2 ГБ — по объёму трогать нечего, и по возрасту тоже
  const r = await housekeepImgCache(now, dir)
  assert.equal(r.removed, 0)
})

test('housekeeping: превышение объёма чистит самое старое по mtime, пока не впишется в лимит', async () => {
  const dir = await tmpCacheDir()
  const now = Date.now()
  const size = 400
  await writeEntry(dir, 'oldest', size, 40 * 24 * 3600_000, now)
  await writeEntry(dir, 'middle', size, 20 * 24 * 3600_000, now)
  await writeEntry(dir, 'newest', size, 10 * 24 * 3600_000, now)

  // лимит в 900 байт вмещает максимум 2 файла по 400 — самый старый должен уйти
  const r = await housekeepImgCache(now, dir, 900)
  assert.equal(r.removed, 1)
  assert.equal(r.freedBytes, size)
  assert.deepEqual(
    (await readdir(dir)).sort(),
    ['middle', 'middle.type', 'newest', 'newest.type'],
  )
})

test('housekeeping: чистка по объёму не трогает файлы младше HOUSEKEEP_MIN_FILE_AGE_MS, даже если лимит превышен', async () => {
  const dir = await tmpCacheDir()
  const now = Date.now()
  await writeEntry(dir, 'brand-new', 1000, 10_000, now) // моложе HOUSEKEEP_MIN_FILE_AGE_MS

  // лимит заведомо меньше единственного файла — но он слишком «свежий», чтобы его трогать
  const r = await housekeepImgCache(now, dir, 100)
  assert.equal(r.removed, 0)
})

test('housekeeping: пустая/отсутствующая директория — не падает', async () => {
  const dir = join(tmpdir(), 'mnz-imgcache-does-not-exist-' + Date.now())
  const r = await housekeepImgCache(Date.now(), dir)
  assert.deepEqual(r, { scanned: 0, removed: 0, freedBytes: 0 })
})
