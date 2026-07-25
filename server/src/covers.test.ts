/**
 * Обработка пользовательских фото обложек (stage 3.2 текущего аудита).
 * Запуск: npm run test -w server
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'

process.env.DISABLE_BOT = '1' // covers.ts тянет env.ts, а тому нужен BOT_TOKEN без этого флага

const { normalizeForStorage } = await import('./covers.js')
type Decoded = Awaited<ReturnType<typeof normalizeForStorage>>

const decodedOf = async (buffer: Buffer, mediaType: Decoded['mediaType']): Promise<Decoded> => ({
  buffer,
  mediaType,
  data: buffer.toString('base64'),
})

/** JPEG 40×20 с EXIF orientation=6 (повёрнуто на 90°) и GPS-координатами съёмки. */
async function jpegWithExifAndGps(): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .jpeg()
    .withMetadata({
      orientation: 6,
      exif: {
        IFD0: {
          Software: 'test-camera',
          GPSLatitude: '52,10,0',
          GPSLatitudeRef: 'N',
          GPSLongitude: '20,59,0',
          GPSLongitudeRef: 'E',
        },
      },
    })
    .toBuffer()
}

test('нормализация фото: EXIF-поворот переносится в пиксели, EXIF/GPS в выводе отсутствует', async () => {
  const input = await jpegWithExifAndGps()
  const inputMeta = await sharp(input).metadata()
  // подтверждаем, что тестовое фото действительно несёт то, что мы проверяем
  assert.equal(inputMeta.orientation, 6)
  assert.ok(inputMeta.exif && inputMeta.exif.length > 0, 'входной файл должен содержать EXIF')

  const out = await normalizeForStorage(await decodedOf(input, 'image/jpeg'))
  const outMeta = await sharp(out.buffer).metadata()

  // orientation=6 = поворот на 90°: было 40×20, после коррекции — 20×40
  assert.equal(outMeta.width, 20)
  assert.equal(outMeta.height, 40)
  // EXIF (а значит и вложенный в него GPS) в результате быть не должно
  assert.ok(!outMeta.exif, 'EXIF/GPS должны быть удалены при сохранении')
  assert.equal(out.mediaType, 'image/webp')
})

test('нормализация фото: не увеличивает маленькое изображение', async () => {
  const tiny = await sharp({ create: { width: 30, height: 30, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .png()
    .toBuffer()
  const out = await normalizeForStorage(await decodedOf(tiny, 'image/png'))
  const outMeta = await sharp(out.buffer).metadata()
  assert.equal(outMeta.width, 30)
  assert.equal(outMeta.height, 30)
})

test('нормализация фото: большое изображение обрезается до разумного максимума ширины', async () => {
  const big = await sharp({ create: { width: 4000, height: 6000, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .jpeg()
    .toBuffer()
  const out = await normalizeForStorage(await decodedOf(big, 'image/jpeg'))
  const outMeta = await sharp(out.buffer).metadata()
  assert.ok(outMeta.width! <= 1600, `ширина ${outMeta.width} должна быть не больше 1600`)
  assert.ok(outMeta.width! < 4000)
})

test('нормализация фото: анимированный GIF не трогаем (не схлопываем до одного кадра)', async () => {
  const gif = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 5, g: 5, b: 5 } } })
    .gif()
    .toBuffer()
  const decoded = await decodedOf(gif, 'image/gif')
  const out = await normalizeForStorage(decoded)
  // GIF отдаём как получили — байт в байт, без ресайза/перекодирования
  assert.equal(out.mediaType, 'image/gif')
  assert.ok(out.buffer.equals(decoded.buffer))
})

test('нормализация фото: битый вход не роняет загрузку — возвращаем как получили', async () => {
  const garbage: Decoded = { buffer: Buffer.from('not an image'), mediaType: 'image/jpeg', data: '' }
  const out = await normalizeForStorage(garbage)
  assert.ok(out.buffer.equals(garbage.buffer))
})
