#!/usr/bin/env bash
# РАЗОВАЯ подготовка сервера к атомарным релизам. Идемпотентна: можно запускать повторно.
#
# Было: код лежал прямо в /opt/mnenezhalko, деплой распаковывал архив ПОВЕРХ живого
# каталога и там же собирал. В это окно запущенный процесс видел смесь старых и
# новых файлов, а на прод приезжали все инструменты разработки.
#
# Становится:
#   /opt/mnenezhalko/releases/<sha>/   — распакованная сборка, только production-зависимости
#   /opt/mnenezhalko/shared/data       — база, обложки, кэш превью (переживает релизы)
#   /opt/mnenezhalko/shared/.env       — секреты (переживают релизы)
#   /opt/mnenezhalko/current -> releases/<sha>
#
# Данные и .env НЕ копируются, а ПЕРЕНОСЯТСЯ: две копии базы рядом это худшее,
# что может случиться с сервисом (запись пойдёт не туда, где читают).
set -euo pipefail

HOST="${DEPLOY_HOST:-root@46.224.220.94}"
DIR="${DEPLOY_DIR:-/opt/mnenezhalko}"
USER_NAME="${DEPLOY_USER:-mnenezhalko}"

echo "→ подготовка $HOST:$DIR"
ssh "$HOST" "bash -s" <<EOSH
set -euo pipefail
DIR="$DIR"
USER_NAME="$USER_NAME"

mkdir -p "\$DIR/releases" "\$DIR/shared"

# 1. Данные: переносим из старого места ОДИН раз
if [ -d "\$DIR/server/data" ] && [ ! -L "\$DIR/server/data" ] && [ ! -d "\$DIR/shared/data" ]; then
  echo "переношу базу и обложки в shared/data"
  mv "\$DIR/server/data" "\$DIR/shared/data"
elif [ ! -d "\$DIR/shared/data" ]; then
  mkdir -p "\$DIR/shared/data"
fi

# 2. .env: тоже переносим, а не копируем — иначе появится второй, и не угадать, какой читают
if [ -f "\$DIR/server/.env" ] && [ ! -L "\$DIR/server/.env" ] && [ ! -f "\$DIR/shared/.env" ]; then
  echo "переношу .env в shared/.env"
  mv "\$DIR/server/.env" "\$DIR/shared/.env"
fi
if [ ! -f "\$DIR/shared/.env" ]; then
  echo "⚠️  нет \$DIR/shared/.env — положите его вручную (см. .env.example)"
  exit 1
fi

chown -R "\$USER_NAME:\$USER_NAME" "\$DIR/shared/data"
chown root:"\$USER_NAME" "\$DIR/shared/.env"
chmod 640 "\$DIR/shared/.env"

# 3. Прежний код становится обычным релизом: будет куда откатиться на первой же выкладке.
#    Копируем ЖЁСТКИМИ ССЫЛКАМИ (cp -al): node_modules это полгигабайта мелких
#    файлов, а на диске свободно около четырёх — вторая настоящая копия там лишняя.
#    Релизы неизменяемы, поэтому общие inode безопасны.
if [ ! -L "\$DIR/current" ]; then
  LEGACY="\$DIR/releases/legacy-\$(date +%Y%m%d-%H%M)"
  echo "прежний код → \$LEGACY (цель для откатa)"
  mkdir -p "\$LEGACY"
  for item in package.json package-lock.json server web scripts node_modules; do
    [ -e "\$DIR/\$item" ] || continue
    cp -al "\$DIR/\$item" "\$LEGACY/" 2>/dev/null || cp -a "\$DIR/\$item" "\$LEGACY/"
  done
  # внутри релиза данные и .env — только ссылки на shared
  rm -rf "\$LEGACY/server/data" "\$LEGACY/server/.env"
  ln -sfn "\$DIR/shared/data" "\$LEGACY/server/data"
  ln -sfn "\$DIR/shared/.env" "\$LEGACY/server/.env"
  ln -sfn "\$LEGACY" "\$DIR/current"
fi

echo "готово:"
ls -la "\$DIR" | grep -E 'current|releases|shared'
EOSH

echo
echo "→ systemd: юнит должен смотреть на current"
scp scripts/mnenezhalko.service "$HOST:/tmp/mnenezhalko.service"
ssh "$HOST" "bash -s" <<EOSH
set -euo pipefail
cp /etc/systemd/system/mnenezhalko.service "/etc/systemd/system/mnenezhalko.service.bak-\$(date +%Y%m%d-%H%M)"
install -m 644 /tmp/mnenezhalko.service /etc/systemd/system/mnenezhalko.service
systemctl daemon-reload
systemctl restart mnenezhalko
sleep 3
systemctl is-active mnenezhalko
EOSH

echo "→ проверка живого сервиса"
ssh "$HOST" "curl -fsS http://127.0.0.1:${DEPLOY_PORT:-4310}/api/health"
echo
echo "✅ сервер готов к атомарным релизам: дальше bash scripts/release.sh"
