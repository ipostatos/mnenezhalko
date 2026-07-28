/**
 * Безопасный claim выдачи по ссылке-приглашению (stage 6 текущего аудита).
 *
 * Раньше ссылка была `?start=loan_<id выдачи>`, а обработчик /start при ЛЮБОМ
 * заходе (даже без ссылки) подхватывал ВСЕ невостребованные выдачи, у которых
 * holderUsername совпал с ником зашедшего — кто угодно, зарегистрировав в
 * Telegram чужой/распространённый ник, одним /start присваивал себе чужие
 * выдачи по всей библиотеке. Теперь — одноразовый непредсказуемый токен на
 * КОНКРЕТНУЮ выдачу, в базе только его хэш.
 *
 * Своя временная SQLite-база — прод не трогаем.
 * Запуск: npm run test -w server
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `loan-claim-test-${randomUUID()}.db`)
process.env.DATABASE_URL = `file:${DB_FILE}`
process.env.DISABLE_BOT = '1'

execSync('npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma', {
  stdio: 'ignore',
  env: process.env,
})

const { prisma } = await import('./db.js')
const { createLoan, claimLoanByToken, issueClaimToken, markReturned } = await import('./loans.js')

after(async () => {
  await prisma.$disconnect()
  unlinkSync(DB_FILE)
})

let nextTg = 700_000n
async function seedOwner() {
  const tg = nextTg++
  await prisma.user.create({ data: { tgId: tg, username: `owner${tg}` } })
  return tg
}

/** holderTg — внешний ключ на User.tgId, поэтому claimant должен существовать. */
async function ensureUser(tg: bigint, username: string) {
  await prisma.user.upsert({ where: { tgId: tg }, create: { tgId: tg, username }, update: {} })
}

test('валидный claim: правильный токен + совпавший username привязывает выдачу', async () => {
  const ownerTg = await seedOwner()
  const loan = await createLoan({ ownerTg, title: 'Книга A', holder: '@reader_a' })
  assert.ok(loan.claimToken, 'для неизвестного читателя должен быть выпущен токен')

  await ensureUser(111n, 'reader_a')
  const result = await claimLoanByToken(111n, 'reader_a', loan.claimToken!)
  assert.deepEqual(result, { status: 'claimed', loanId: loan.id })

  const fresh = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })
  assert.equal(fresh.holderTg, 111n)
  // хэш намеренно остаётся: holderTg уже занят, но тот же человек должен
  // мочь повторно открыть свою же ссылку (см. следующий тест)
  assert.ok(fresh.claimTokenHash)
})

test('повторный claim тем же человеком — идемпотентно (снова claimed, не ошибка)', async () => {
  const ownerTg = await seedOwner()
  const loan = await createLoan({ ownerTg, title: 'Книга B', holder: '@reader_b' })
  await ensureUser(222n, 'reader_b')
  await claimLoanByToken(222n, 'reader_b', loan.claimToken!)

  const again = await claimLoanByToken(222n, 'reader_b', loan.claimToken!)
  assert.deepEqual(again, { status: 'claimed', loanId: loan.id })
})

test('чужой пользователь: тот же токен, другой tgId — уже занято, не перехватывается', async () => {
  const ownerTg = await seedOwner()
  const loan = await createLoan({ ownerTg, title: 'Книга C', holder: '@reader_c' })
  await ensureUser(333n, 'reader_c')
  await claimLoanByToken(333n, 'reader_c', loan.claimToken!)

  await ensureUser(999n, 'someone_else')
  const stranger = await claimLoanByToken(999n, 'someone_else', loan.claimToken!)
  assert.deepEqual(stranger, { status: 'already_claimed' })

  const fresh = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })
  assert.equal(fresh.holderTg, 333n, 'владельцем выдачи остаётся первый claim')
})

test('несовпадение username: валидный токен, но ник не совпадает — автоклейм запрещён', async () => {
  const ownerTg = await seedOwner()
  const loan = await createLoan({ ownerTg, title: 'Книга D', holder: '@expected_user' })

  const result = await claimLoanByToken(444n, 'wrong_user', loan.claimToken!)
  assert.deepEqual(result, {
    status: 'username_mismatch',
    loanId: loan.id,
    expectedUsername: 'expected_user',
  })

  const fresh = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })
  assert.equal(fresh.holderTg, null, 'выдача не должна привязаться при несовпадении ника')
  assert.ok(fresh.claimTokenHash, 'токен остаётся действителен — настоящий получатель ещё может им воспользоваться')
})

test('возвращённая выдача: claim по токену уже возвращённой книги не проходит', async () => {
  const ownerTg = await seedOwner()
  const loan = await createLoan({ ownerTg, title: 'Книга E', holder: '@reader_e' })
  const token = loan.claimToken!
  await markReturned(loan.id, ownerTg)

  const result = await claimLoanByToken(555n, 'reader_e', token)
  assert.deepEqual(result, { status: 'not_found' })
})

test('истёкший token: claim после истечения срока действия отклоняется', async () => {
  const ownerTg = await seedOwner()
  const loan = await createLoan({ ownerTg, title: 'Книга F', holder: '@reader_f' })
  // искусственно «состариваем» токен
  await prisma.loan.update({ where: { id: loan.id }, data: { claimTokenExpiresAt: new Date(Date.now() - 1000) } })

  const result = await claimLoanByToken(666n, 'reader_f', loan.claimToken!)
  assert.deepEqual(result, { status: 'expired' })
})

test('изменённый token: подделанный/искажённый токен не совпадает ни с одним хэшем', async () => {
  const ownerTg = await seedOwner()
  const loan = await createLoan({ ownerTg, title: 'Книга G', holder: '@reader_g' })
  const tampered = loan.claimToken!.slice(0, -1) + (loan.claimToken!.at(-1) === 'a' ? 'b' : 'a')

  const result = await claimLoanByToken(777n, 'reader_g', tampered)
  assert.deepEqual(result, { status: 'not_found' })

  const fresh = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })
  assert.equal(fresh.holderTg, null)
})

test('старая legacy-ссылка (raw id выдачи без токена) — работает только при совпадении username', async () => {
  const ownerTg = await seedOwner()
  // выдача "из прошлого", как до введения токенов: claimTokenHash изначально null
  const legacy = await prisma.loan.create({
    data: { ownerTg, title: 'Старая книга', holderUsername: 'legacy_reader', status: 'active' },
  })

  const wrongUser = await claimLoanByToken(888n, 'someone_else', legacy.id)
  assert.deepEqual(wrongUser, { status: 'not_found' })

  await ensureUser(889n, 'legacy_reader')
  const rightUser = await claimLoanByToken(889n, 'legacy_reader', legacy.id)
  assert.deepEqual(rightUser, { status: 'claimed', loanId: legacy.id })
})

test('один токен не влияет на другие выдачи того же username (нет bulk-захвата)', async () => {
  const ownerTg = await seedOwner()
  const loanX = await createLoan({ ownerTg, title: 'Книга X', holder: '@same_username' })
  const loanY = await createLoan({ ownerTg, title: 'Книга Y', holder: '@same_username' })

  await ensureUser(900n, 'same_username')
  await claimLoanByToken(900n, 'same_username', loanX.claimToken!)

  const freshX = await prisma.loan.findUniqueOrThrow({ where: { id: loanX.id } })
  const freshY = await prisma.loan.findUniqueOrThrow({ where: { id: loanY.id } })
  assert.equal(freshX.holderTg, 900n, 'заявленная по токену выдача привязалась')
  assert.equal(freshY.holderTg, null, 'вторая выдача того же username НЕ должна была подхватиться заодно')
})

test('issueClaimToken выпускает новый токен и гасит предыдущий (для напоминаний)', async () => {
  const ownerTg = await seedOwner()
  const loan = await createLoan({ ownerTg, title: 'Книга H', holder: '@reader_h' })
  const oldToken = loan.claimToken!

  const newToken = await issueClaimToken(loan.id)
  assert.notEqual(newToken, oldToken)

  const oldResult = await claimLoanByToken(101n, 'reader_h', oldToken)
  assert.deepEqual(oldResult, { status: 'not_found' }, 'старый токен должен перестать работать')

  await ensureUser(101n, 'reader_h')
  const newResult = await claimLoanByToken(101n, 'reader_h', newToken)
  assert.deepEqual(newResult, { status: 'claimed', loanId: loan.id })
})

test('пустой payload — not_found, без побочных эффектов', async () => {
  const result = await claimLoanByToken(102n, 'anyone', undefined)
  assert.deepEqual(result, { status: 'not_found' })
})

/* ── аудит 2026-07-28, P1.1: ник — подсказка, а не идентификатор ── */

test('известный боту ник НЕ привязывает выдачу автоматически — только claim-токен', async () => {
  const ownerTg = await seedOwner()
  // человек с таким ником уже писал боту — но ник мог быть переназначен
  await ensureUser(1200n, 'known_reader')
  const loan = await createLoan({ ownerTg, title: 'Книга K', holder: '@known_reader' })

  assert.equal(loan.holderTg, null, 'автопривязки по нику быть не должно')
  assert.ok(loan.claimToken, 'привязка — только через ссылку-приглашение')

  // настоящий обладатель ника проходит по токену как обычно
  const r = await claimLoanByToken(1200n, 'known_reader', loan.claimToken!)
  assert.deepEqual(r, { status: 'claimed', loanId: loan.id })
})

test('проверенный tgId (holderTgVerified) привязывает сразу, без токена', async () => {
  const ownerTg = await seedOwner()
  await ensureUser(1300n, 'trusted_reader')
  const loan = await createLoan({
    ownerTg,
    title: 'Книга L',
    holder: '@trusted_reader',
    holderTgVerified: 1300n,
  })
  assert.equal(loan.holderTg, 1300n)
  assert.equal(loan.claimToken, null, 'токен не нужен — id уже подтверждён')
})

test('ник нормализуется: @MixedCase хранится как mixedcase и claim регистронезависим', async () => {
  const ownerTg = await seedOwner()
  const loan = await createLoan({ ownerTg, title: 'Книга M', holder: '@MixedCase' })
  const fresh = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })
  assert.equal(fresh.holderUsername, 'mixedcase')

  await ensureUser(1400n, 'MIXEDCASE')
  const r = await claimLoanByToken(1400n, 'MIXEDCASE', loan.claimToken!)
  assert.deepEqual(r, { status: 'claimed', loanId: loan.id })
})
