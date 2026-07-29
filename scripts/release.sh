#!/usr/bin/env bash
# Атомарная выкладка: готовая сборка из CI → releases/<sha> → переключение current.
#
# Отличия от старого scripts/deploy.sh:
#   * на сервере НИЧЕГО не собирается — приезжает архив, собранный в CI;
#   * ставятся только production-зависимости, инструментов разработки на проде нет;
#   * новый релиз готовится РЯДОМ, а живой процесс до последнего момента работает
#     на прежнем: переключение это одна операция (rename симлинка);
#   * не прошла проверка живости — автоматический возврат на предыдущий релиз.
#
# Использование:
#   bash scripts/release.sh              # взять артефакт CI для текущего HEAD
#   bash scripts/release.sh --local      # собрать локально (когда CI недоступен)
#
# Перед первым запуском: bash scripts/release-setup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${DEPLOY_HOST:-root@46.224.220.94}"
DIR="${DEPLOY_DIR:-/opt/mnenezhalko}"
PORT="${DEPLOY_PORT:-4310}"
USER_NAME="${DEPLOY_USER:-mnenezhalko}"
# Сколько релизов держать. Два: текущий и предыдущий (цель откатa) — больше на
# этой машине не влезает. Зависимости релиза около 350 МБ (178 из них Prisma),
# а на диске свободно чуть больше трёх гигабайт, и 21 ГБ там держит соседний проект.
KEEP="${KEEP_RELEASES:-2}"
MODE="${1:-}"

SHA="$(git -C "$ROOT" rev-parse HEAD)"
VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo unknown)"
SHORT="${SHA:0:7}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  echo "⚠️  в рабочем дереве есть незакоммиченные правки — релиз собирается из HEAD ($SHORT)"
fi

ARCHIVE="$WORK/release.tar.gz"

if [ "$MODE" = "--local" ]; then
  echo "→ локальная сборка (CI не используется)"
  (cd "$ROOT" && npm run build >/dev/null)
  tar -czf "$ARCHIVE" -C "$ROOT" \
    package.json package-lock.json \
    server/package.json server/dist server/prisma \
    web/package.json web/dist \
    scripts
else
  echo "→ беру артефакт CI для $SHORT"
  RUN_ID="$(gh run list --workflow CI --json databaseId,headSha,conclusion \
    --jq "[.[] | select(.headSha==\"$SHA\" and .conclusion==\"success\")][0].databaseId")"
  if [ -z "$RUN_ID" ] || [ "$RUN_ID" = "null" ]; then
    echo "❌ нет успешного прогона CI для $SHORT."
    echo "   Подождите CI, или соберите локально: bash scripts/release.sh --local"
    exit 1
  fi
  gh run download "$RUN_ID" --name "release-$SHA" --dir "$WORK" >/dev/null
  found="$(ls "$WORK"/*.tar.gz 2>/dev/null | head -1 || true)"
  [ -n "$found" ] || { echo "❌ в артефакте нет архива"; exit 1; }
  mv "$found" "$ARCHIVE"
fi

echo "→ архив $(du -h "$ARCHIVE" | cut -f1), везу на сервер"
scp -q "$ARCHIVE" "$HOST:/tmp/release-$SHORT.tar.gz"

# Куда распаковывать. ⚠️ Если каталог этого sha УЖЕ является текущим релизом
# (повторная выкладка того же коммита), очищать его нельзя: это работающий прод.
# В таком случае готовим отдельный каталог с отметкой времени.
CURRENT_REAL="$(ssh "$HOST" "readlink -f $DIR/current 2>/dev/null || true")"
REL="$SHA"
if [ "$CURRENT_REAL" = "$DIR/releases/$SHA" ]; then
  REL="$SHA-$(date +%H%M%S)"
  echo "→ этот коммит уже в проде; готовлю отдельный каталог releases/$REL"
fi

echo "→ готовлю релиз рядом с работающим"
ssh "$HOST" "bash -s" <<EOSH
set -euo pipefail
DIR="$DIR"
REL="$REL"
USER_NAME="$USER_NAME"
NEW="\$DIR/releases/\$REL"

# каталог этого релиза точно не текущий (проверено выше) — можно начинать с чистого
rm -rf "\$NEW"
mkdir -p "\$NEW"
tar -xzf "/tmp/release-$SHORT.tar.gz" -C "\$NEW"
rm -f "/tmp/release-$SHORT.tar.gz"

# данные и секреты живут в shared: релиз ссылается на них, а не носит копию
rm -rf "\$NEW/server/data" "\$NEW/server/.env"
ln -sfn "\$DIR/shared/data" "\$NEW/server/data"
ln -sfn "\$DIR/shared/.env" "\$NEW/server/.env"

# Чем именно работает процесс: sha попадает в /api/health, и проверка живости
# отличает новый процесс от пережившего рестарт старого
printf 'RELEASE_SHA=%s\nRELEASE_VERSION=%s\n' "\$REL" "$VERSION" > "\$NEW/server/.release-env"

cd "\$NEW"
# ⚠️ --omit=dev: на проде не должно быть ни vite, ни tsc, ни браузеров Playwright.
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD — вторая страховка на случай, если инструмент
# разработки когда-нибудь окажется в production-зависимостях
# -w server: ставим зависимости ТОЛЬКО сервера. Mini App уже собран в web/dist,
# и react с иконками (около 45 МБ) на сервере не нужны ни секунды
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund -w server   --include-workspace-root >/dev/null
# нативный клиент Prisma генерируется здесь: движок зависит от системы,
# а не от машины, где собирали
(cd server && npx prisma generate >/dev/null)

echo "  зависимости: \$(du -sh node_modules | cut -f1)"
EOSH

# Снимок базы ПЕРЕД миграциями.
#
# Откат симлинка возвращает КОД, но не базу: миграции уже применены к живой базе.
# Для добавляющих изменений это нормально (прежний код просто не знает о новых
# колонках), поэтому основное правило беты такое: миграции обязаны быть обратно
# совместимыми, а разрушающие (удаление и перестройка) делаются отдельным
# согласованным релизом. Снимок — страховка на случай, когда правило нарушено.
echo "→ снимок базы перед миграциями"
ssh "$HOST" "bash -s" <<EOSH
set -euo pipefail
SNAP="$DIR/shared/data/predeploy-$SHORT.db"
sqlite3 "$DIR/shared/data/mnenezhalko.db" ".backup '\$SNAP'"
chown "$USER_NAME:$USER_NAME" "\$SNAP"
echo "  \$(du -h "\$SNAP" | cut -f1) → \$SNAP"
# держим только два последних снимка: диск тесный
ls -1t "$DIR/shared/data"/predeploy-*.db 2>/dev/null | tail -n +3 | xargs -r rm -f
EOSH

echo "→ миграции базы (на живой базе, до переключения)"
ssh "$HOST" "cd $DIR/releases/$REL && bash scripts/db-migrate.sh"

echo "→ переключаю current одной операцией"
PREV="$(ssh "$HOST" "readlink -f $DIR/current || true")"
echo "  предыдущий релиз: ${PREV:-нет}"
ssh "$HOST" "bash -s" <<EOSH
set -euo pipefail
DIR="$DIR"
REL="$REL"
USER_NAME="$USER_NAME"
chown -R "\$USER_NAME:\$USER_NAME" "\$DIR/shared/data"
# rename(2) — либо старая ссылка, либо новая, промежуточного состояния не бывает
ln -sfn "\$DIR/releases/\$REL" "\$DIR/current.tmp"
mv -Tf "\$DIR/current.tmp" "\$DIR/current"
systemctl restart mnenezhalko
EOSH

# Проверяем не «кто-то ответил», а «ответил ИМЕННО новый релиз»: если systemd
# по какой-то причине не перезапустил процесс, старый ответил бы бодрым ok и
# выкладка сочла бы новый успешным.
echo "→ проверка живости и что отвечает именно новый релиз"
ok=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 2
  got="$(ssh "$HOST" "curl -fsS --max-time 5 http://127.0.0.1:$PORT/api/health 2>/dev/null" || true)"
  case "$got" in
    *'"ok":true'*)
      if printf '%s' "$got" | grep -q "\"sha\":\"$REL\""; then
        ok=1
        break
      fi
      echo "  отвечает, но ещё прежний релиз (попытка $i)"
      ;;
    *) echo "  попытка $i…" ;;
  esac
done

if [ "$ok" != "1" ]; then
  echo "❌ сервис не ответил. ВОЗВРАЩАЮ предыдущий релиз"
  if [ -n "$PREV" ]; then
    ssh "$HOST" "bash -s" <<EOSH
set -euo pipefail
ln -sfn "$PREV" "$DIR/current.tmp"
mv -Tf "$DIR/current.tmp" "$DIR/current"
systemctl restart mnenezhalko
sleep 5
systemctl is-active mnenezhalko || true
curl -fsS --max-time 5 http://127.0.0.1:$PORT/api/health || echo '⚠️ и предыдущий релиз не отвечает — смотреть journalctl -u mnenezhalko'
EOSH
    echo "↩️  откат выполнен на $PREV"
  else
    echo "⚠️  откатываться некуда: предыдущего релиза нет"
  fi
  echo
  echo "Логи: ssh $HOST 'journalctl -u mnenezhalko -n 50 --no-pager'"
  exit 1
fi

echo "→ живой сервис:"
ssh "$HOST" "curl -fsS http://127.0.0.1:$PORT/api/health"
echo

echo "→ чищу старые релизы (оставляю $KEEP)"
ssh "$HOST" "bash -s" <<EOSH
set -euo pipefail
DIR="$DIR"
KEEP="$KEEP"
CURRENT="\$(readlink -f "\$DIR/current")"
cd "\$DIR/releases"
# по времени изменения, но текущий не трогаем ни при каких обстоятельствах
ls -1dt */ 2>/dev/null | tail -n +\$((KEEP + 1)) | while read -r old; do
  full="\$DIR/releases/\${old%/}"
  [ "\$full" = "\$CURRENT" ] && continue
  echo "  удаляю \${old%/}"
  rm -rf "\$full"
done
echo "  осталось: \$(ls -1d */ 2>/dev/null | wc -l)"
df -h "\$DIR" | tail -1
EOSH

echo
echo "✅ релиз $SHORT в проде (current → releases/$REL)"
