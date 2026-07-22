#!/usr/bin/env bash
# Выкладка на VPS. Запускать из git-bash на машине разработчика.
#
# ВАЖНО: всегда `git -C "$ROOT" archive` — `git archive` из подкаталога
# упакует только его и затрёт корневые файлы на сервере.
#
# Первый раз на сервере:
#   mkdir -p /opt/mnenezhalko/server/data
#   cp .env /opt/mnenezhalko/server/.env      # BOT_MODE=webhook, PUBLIC_URL=…
#   cp scripts/mnenezhalko.service /etc/systemd/system/ && systemctl enable mnenezhalko
#   в Caddyfile добавить блок из scripts/Caddyfile.snippet && systemctl reload caddy
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${DEPLOY_HOST:-root@46.224.220.94}"
DIR="${DEPLOY_DIR:-/opt/mnenezhalko}"

echo "→ архивирую HEAD и распаковываю в $HOST:$DIR"
git -C "$ROOT" archive HEAD | ssh "$HOST" "mkdir -p $DIR && tar -x -C $DIR"

echo "→ сборка и рестарт"
ssh "$HOST" "cd $DIR && npm i --no-audit --omit=dev=false \
  && npm run build -w web \
  && cd server && npx prisma generate && npx prisma db push --skip-generate \
  && npx tsc -p tsconfig.json \
  && systemctl restart mnenezhalko && sleep 3 && systemctl is-active mnenezhalko"

echo "→ проверка живого сервиса"
ssh "$HOST" "curl -fsS http://127.0.0.1:${DEPLOY_PORT:-4310}/api/health"
echo
echo "✅ готово"
