#!/usr/bin/env bash
# Выкладка дневника работ на VPS (отдельный поддомен, к сервису бота не относится).
#
#   https://mnenezhalko-diary-46-224-220-94.sslip.io/           - дневник для заказчика
#   https://mnenezhalko-diary-46-224-220-94.sslip.io/DIARY.md   - подробная техническая версия
#   https://mnenezhalko-diary-46-224-220-94.sslip.io/status.html - статус по списку запросов (25.07, архив)
#
# Страница статическая: файлы просто копируются, Caddy отдаёт каталог как есть
# (блок mnenezhalko-diary в /etc/caddy/Caddyfile, X-Robots-Tag noindex).
# Никакой сборки и рестарта не нужно, прод бота эта команда НЕ трогает.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${DEPLOY_HOST:-root@46.224.220.94}"
DIR="${DIARY_DIR:-/opt/mnenezhalko-diary}"

echo "→ копирую дневник в $HOST:$DIR"
# по одному файлу через stdin: без rsync и без прав на чужие файлы в каталоге
ssh "$HOST" "mkdir -p $DIR"
ssh "$HOST" "cat > $DIR/index.html" < "$ROOT/docs/mnenezhalko-diary.html"
ssh "$HOST" "cat > $DIR/DIARY.md" < "$ROOT/docs/DIARY.md"
ssh "$HOST" "chmod 644 $DIR/index.html $DIR/DIARY.md"

echo "→ проверка живой страницы"
URL="${DIARY_URL:-https://mnenezhalko-diary-46-224-220-94.sslip.io}"
# проверяем С САМОГО СЕРВЕРА: curl из Windows (schannel) не умеет sslip.io-имена
# и падает с SEC_E_WRONG_PRINCIPAL, хотя страница в порядке
ssh "$HOST" "curl -fsS -o /dev/null '$URL/' && curl -fsS -o /dev/null '$URL/DIARY.md'"
echo "✅ готово: $URL"
