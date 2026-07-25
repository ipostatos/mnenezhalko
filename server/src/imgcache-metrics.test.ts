/**
 * Метрики image pipeline (stage 4.1/4.2 текущего аудита) — только детерминированные
 * пути (без реальной сети): плохая подпись и приватный host отклоняются мгновенно
 * SSRF-фильтром, без DNS/сетевого ожидания.
 * Запуск: npm run test -w server
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DISABLE_BOT = '1' // imgcache.ts тянет env.ts → нужен BOT_TOKEN без этого флага

const { cachedImage, proxyCover, imgPipelineMetrics } = await import('./imgcache.js')

test('метрики: несовпавшая подпись → null, счётчики HIT/MISS/NEGATIVE не меняются', async () => {
  const before = await imgPipelineMetrics()
  const r = await cachedImage('https://example.com/x.jpg', 100, 'not-a-real-signature')
  assert.equal(r, null)
  const after = await imgPipelineMetrics()
  assert.equal(after.hit, before.hit)
  assert.equal(after.miss, before.miss)
  assert.equal(after.negative, before.negative)
})

test('метрики: приватный host отклоняется SSRF-фильтром → NEGATIVE, попадает в originFailures.private_host', async () => {
  const url = 'http://127.0.0.1:1/x.jpg'
  const proxied = proxyCover(url, 111)!
  const params = new URL('http://x' + proxied).searchParams
  const u = params.get('u')!
  const w = Number(params.get('w'))
  const s = params.get('s')!

  const before = await imgPipelineMetrics()
  const r = await cachedImage(u, w, s)
  assert.deepEqual(r, { cache: 'NEGATIVE' })
  const after = await imgPipelineMetrics()
  assert.equal(after.negative, before.negative + 1)
  assert.equal(after.originFailures.private_host ?? 0, (before.originFailures.private_host ?? 0) + 1)

  // повтор в течение TTL негативного кэша — снова NEGATIVE, но уже коротким замыканием
  // (без новой попытки сети): originFailures.private_host на этот раз НЕ растёт
  const afterFirst = await imgPipelineMetrics()
  const r2 = await cachedImage(u, w, s)
  assert.deepEqual(r2, { cache: 'NEGATIVE' })
  const afterSecond = await imgPipelineMetrics()
  assert.equal(afterSecond.negative, afterFirst.negative + 1)
  assert.equal(afterSecond.originFailures.private_host, afterFirst.originFailures.private_host)
})

test('метрики: снимок содержит диск (файлы/байты) и bucketed-длительности', async () => {
  const snap = await imgPipelineMetrics()
  assert.equal(typeof snap.cacheFiles, 'number')
  assert.equal(typeof snap.cacheBytes, 'number')
  assert.ok(Array.isArray(snap.durationBuckets))
  assert.ok(snap.durationBuckets.length > 1)
  // последний бакет — «свыше N» — под null
  assert.equal(snap.durationBuckets.at(-1)!.under_ms, null)
})
