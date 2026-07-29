#!/usr/bin/env bash
# Выкладка на VPS. Запускать из git-bash на машине разработчика.
#
# ВАЖНО: всегда `git -C "$ROOT" archive` — `git archive` из подкаталога
# упакует только его и затрёт корневые файлы на сервере.
#
# Первый раз на сервере:
#   useradd --system --home /opt/mnenezhalko --shell /usr/sbin/nologin mnenezhalko
#   mkdir -p /opt/mnenezhalko/server/data
#   cp .env /opt/mnenezhalko/server/.env      # BOT_MODE=webhook, PUBLIC_URL=…
#   chown root:root /opt/mnenezhalko/server/.env && chmod 600 …  # читает systemd
#   cp scripts/mnenezhalko.service /etc/systemd/system/ && systemctl enable mnenezhalko
#   в Caddyfile добавить блок из scripts/Caddyfile.snippet && systemctl reload caddy
#   crontab -e → 34 3 * * * /opt/mnenezhalko/scripts/backup.sh >> /var/log/mnenezhalko-backup.log 2>&1
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${DEPLOY_HOST:-root@46.224.220.94}"
DIR="${DEPLOY_DIR:-/opt/mnenezhalko}"

echo "→ архивирую HEAD и распаковываю в $HOST:$DIR"
git -C "$ROOT" archive HEAD | ssh "$HOST" "mkdir -p $DIR && tar -x -C $DIR"

echo "→ сборка и рестарт"
# npm ci — воспроизводимая установка строго по lock-файлу (раньше стоял
# невалидный «npm i --omit=dev=false», который работал случайно).
#
# ⚠️ Сборка требует dev-зависимостей (vite, tsc, prisma CLI), поэтому `--omit=dev`
# здесь не поставить. А среди них есть @playwright/test, который на postinstall
# тянет БРАУЗЕР — сотни мегабайт на машину, где свободно около 4 ГБ, и ни одной
# причины ему там быть: сквозные проверки гоняет CI.
#
# Две страховки сразу: скачивание выключено, а каталог браузеров уведён в наш
# собственный. Второе важно не меньше первого — общий кэш /root/.cache/ms-playwright
# на этой машине ЗАНЯТ: там рабочий Chromium FlyGO, которым его бот ходит за
# рейсами. Ни ставить туда своё, ни чистить его мы не имеем права.
#
# Правильное решение — собирать в CI и привозить сюда готовый артефакт с одними
# только production-зависимостями; описано в docs/TECH_DEBT.md, раздел 1.1.
ssh "$HOST" "cd $DIR && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PLAYWRIGHT_BROWSERS_PATH=$DIR/.no-browsers npm ci --no-audit \
  && npm run build -w web \
  && cd server && npx prisma generate && cd .. \
  && bash scripts/db-migrate.sh \
  && cd server && npx tsc -p tsconfig.json \
  && chown -R mnenezhalko:mnenezhalko $DIR/server/data \
  && systemctl restart mnenezhalko && sleep 3 && systemctl is-active mnenezhalko"

echo "→ проверка живого сервиса"
ssh "$HOST" "curl -fsS http://127.0.0.1:${DEPLOY_PORT:-4310}/api/health"

# предохранитель, а не только переменная: узнать о лишних сотнях мегабайт нужно
# сразу, а не когда кончится диск. Смотрим ТОЛЬКО свой каталог: общий кэш
# /root/.cache/ms-playwright — чужой, там браузер работающего FlyGO
echo
echo "→ проверка, что браузеры Playwright к нам не приехали"
ssh "$HOST" "if [ -n \"\$(ls -A $DIR/.no-browsers 2>/dev/null)\" ]; then \
    echo '⚠️  браузеры всё-таки скачались:'; du -sh $DIR/.no-browsers; \
    echo '    удалить: rm -rf $DIR/.no-browsers'; exit 1; \
  else echo 'наш каталог браузеров пуст — хорошо'; fi
  df -h $DIR | tail -1"
echo
echo "✅ готово"
