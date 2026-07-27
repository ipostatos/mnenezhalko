#!/usr/bin/env bash
# Приводит базу к схеме через МИГРАЦИИ (prisma/migrations), а не `db push`.
#
# Почему не `db push`: он подгоняет базу под схему «как получится», без истории и
# без переноса данных. Пока схема простая, это работает, но любой шаг вроде
# «добавить колонку и заполнить её из существующих строк» так не сделать, а на
# новой unique-колонке push вообще требует --accept-data-loss.
#
# Первый запуск на СУЩЕСТВУЮЩЕЙ базе: таблицы уже созданы прежним `db push`, но
# истории миграций нет. Тогда baseline помечается применённой (структуру она
# описывает ровно ту же), и дальше накатываются только следующие миграции.
# На ПУСТОЙ базе (новая локация) baseline применяется обычным порядком и создаёт
# таблицы сама.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../server"

BASELINE="20260727000000_baseline"
DB_FILE="${DB_FILE:-data/mnenezhalko.db}"

has_table() { # $1 — имя таблицы
  [ -f "$DB_FILE" ] || return 1
  command -v sqlite3 >/dev/null 2>&1 || return 1
  [ -n "$(sqlite3 "$DB_FILE" "SELECT name FROM sqlite_master WHERE type='table' AND name='$1';" 2>/dev/null)" ]
}

if has_table Book && ! has_table _prisma_migrations; then
  echo "→ база уже существует, истории миграций нет: принимаю текущую схему как baseline"
  npx prisma migrate resolve --applied "$BASELINE"
fi

echo "→ применяю миграции"
npx prisma migrate deploy
