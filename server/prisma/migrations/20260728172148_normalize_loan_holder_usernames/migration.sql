-- Ники Telegram регистронезависимы, а сравнение строк в SQLite — нет: `@Anna`
-- и `anna` не совпадали при claim. Новые выдачи пишут канонический lower-case
-- (normHandle), старые приводим здесь. Заодно срезаем случайный «@» в начале.
UPDATE "Loan"
SET "holderUsername" = lower(ltrim("holderUsername", '@'))
WHERE "holderUsername" IS NOT NULL
  AND "holderUsername" <> lower(ltrim("holderUsername", '@'));
