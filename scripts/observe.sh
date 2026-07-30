#!/usr/bin/env bash
# Обход показаний прода за неделю наблюдения (см. docs/OBSERVATION_GATE.md).
#
# Только читает: ни одной записи в базу, ни одного рестарта. Пороги и реакции
# описаны в том же документе; здесь они продублированы значениями, потому что
# скрипт должен сам говорить «норма / предупреждение / инцидент», а не заставлять
# сверять числа глазами.
#
# Запуск: bash scripts/observe.sh
# С Windows домен sslip.io не резолвится, поэтому всё читаем по SSH с самой машины.
set -euo pipefail

HOST="${DEPLOY_HOST:-root@46.224.220.94}"
DIR="${DEPLOY_DIR:-/opt/mnenezhalko}"
PORT="${DEPLOY_PORT:-4310}"

ssh "$HOST" "DIR='$DIR' PORT='$PORT' bash -s" <<'REMOTE'
set -u
DB="$DIR/shared/data/mnenezhalko.db"
q() { sqlite3 "$DB" "$1" 2>/dev/null || echo "?"; }
now=$(date -u +%s)
problems=0
warns=0

say()  { printf '  %s\n' "$1"; }
ok()   { printf '  ✅ %s\n' "$1"; }
warn() { printf '  ⚠️  %s\n' "$1"; warns=$((warns+1)); }
bad()  { printf '  🔴 %s\n' "$1"; problems=$((problems+1)); }

echo "════ процесс ════"
active=$(systemctl is-active mnenezhalko || true)
[ "$active" = "active" ] && ok "служба active" || bad "служба НЕ active ($active)"
restarts=$(systemctl show mnenezhalko -p NRestarts --value)
started=$(systemctl show mnenezhalko -p ActiveEnterTimestamp --value)
# рестарт без выкладки — инцидент: systemd поднял упавший процесс
if [ "${restarts:-0}" -gt 0 ]; then
  bad "systemd перезапускал процесс $restarts раз(а) — искать причину в journalctl"
else
  ok "перезапусков процессом не было (NRestarts=0), поднят: $started"
fi
errs=$(journalctl -u mnenezhalko --since "24 hours ago" -p err --no-pager 2>/dev/null | grep -vc "No entries" || true)
[ "${errs:-0}" -eq 0 ] && ok "ошибок в журнале за сутки нет" || warn "строк уровня error за сутки: $errs"
health=$(curl -s --max-time 5 "localhost:$PORT/api/health" || echo '')
if echo "$health" | grep -q '"ok":true'; then
  sha=$(echo "$health" | sed -n 's/.*"sha":"\([^"]*\)".*/\1/p')
  ver=$(echo "$health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
  ok "health отвечает: версия $ver, релиз ${sha:0:7}"
  [ "$ver" = "unknown" ] && warn "версия «unknown» — release.sh не прочитал package.json"
else
  bad "health не ответил"
fi

echo "════ диск и данные ════"
free_mb=$(df -Pm / | awk 'NR==2{print $4}')
if   [ "$free_mb" -lt 800 ];  then bad  "свободно ${free_mb} МБ — НОВЫЕ РЕЛИЗЫ НЕ ВЫКЛАДЫВАТЬ (релиз ~354 МБ)"
elif [ "$free_mb" -lt 1536 ]; then warn "свободно ${free_mb} МБ — чистить imgcache и journalctl"
else ok "свободно $((free_mb/1024)),$(( (free_mb%1024)*10/1024 )) ГБ"; fi
say "база: $(du -h "$DB" 2>/dev/null | cut -f1), превью: $(du -sh "$DIR/shared/data/imgcache" 2>/dev/null | cut -f1), фото: $(du -sh "$DIR/shared/data/covers" 2>/dev/null | cut -f1)"
say "релизы: $(du -sh "$DIR/releases" 2>/dev/null | cut -f1) ($(ls "$DIR/releases" | wc -l) шт)"

echo "════ письма о решениях ════"
stuck=$(q "select count(*) from NotificationOutbox where sentAt is null and attempts>=3")
pending=$(q "select count(*) from NotificationOutbox where sentAt is null")
[ "$stuck" = "0" ] && ok "застрявших нет (в очереди $pending)" \
  || bad "не доставлено $stuck письм(а) после трёх попыток — человек не узнал о решении"
lasterr=$(q "select lastError from NotificationOutbox where lastError is not null and lastError<>'' order by createdAt desc limit 1")
[ -n "$lasterr" ] && [ "$lasterr" != "?" ] && say "последняя ошибка доставки: $lasterr" || true

echo "════ модерация ════"
say "на проверке: $(q "select count(*) from Book where reviewStatus='pending'"), решений в журнале: $(q "select count(*) from ModerationAction")"
approving=$(q "select count(*) from Book where reviewStatus='approving' and approvalStartedAt < datetime('now','-30 minutes')")
[ "$approving" = "0" ] && ok "зависших в approving нет" \
  || bad "в approving дольше 30 минут: $approving — процесс падал посреди публикации в Notion"
say "скрытых отзывов: $(q "select count(*) from Review where status='hidden'"), ограничений: $(q "select count(*) from UserRestriction where liftedAt is null and (expiresAt is null or expiresAt > datetime('now'))"), заблокировано: $(q "select count(*) from User where accountStatus='banned'")"

echo "════ джобы планировщика ════"
# срок каждой джобы свой; здесь общее правило: два интервала без успеха это инцидент
while IFS='|' read -r key val; do
  [ -z "$key" ] && continue
  name="${key#job:}"; name="${name%:lastSuccessAt}"
  age=$(( (now - $(date -u -d "$val" +%s 2>/dev/null || echo "$now")) / 60 ))
  err=$(q "select value from SyncState where key='job:$name:lastError'")
  if [ -n "$err" ] && [ "$err" != "?" ]; then bad "$name: ошибка «$err»"
  else say "$name: успех $age мин назад"; fi
done <<< "$(q "select key, value from SyncState where key like 'job:%:lastSuccessAt' order by key")"

echo "════ Notion ════"
sync_at=$(q "select value from SyncState where key='notion'")
sync_age=$(( (now - $(date -u -d "$sync_at" +%s 2>/dev/null || echo "$now")) / 3600 ))
tok=$(q "select value from SyncState where key='notion:tokenOk'")
[ "$tok" = "1" ] && ok "cookie жива, синк $sync_age ч назад" || bad "cookie Notion не работает (tokenOk=$tok)"
# период синка 12 ч; два периода без успеха это уже не задержка
[ "$sync_age" -gt 24 ] && bad "синк не проходил $sync_age ч (период 12 ч)" || true
alert=$(q "select value from SyncState where key='syncAlert'")
[ -n "$alert" ] && [ "$alert" != "?" ] && warn "предохранитель синка: $alert" || true

echo "════ бэкап ════"
last=$(ls -t /opt/backups/mnenezhalko/*.db.gz 2>/dev/null | head -1)
if [ -z "$last" ]; then bad "копий базы нет вовсе"
else
  age=$(( (now - $(stat -c %Y "$last")) / 3600 ))
  if [ "$age" -gt 26 ]; then bad "последняя копия $age ч назад (cron в 3:34) — $(basename "$last")"
  else ok "последняя копия $age ч назад: $(basename "$last") ($(ls /opt/backups/mnenezhalko/ | wc -l) файлов)"; fi
fi

echo
if [ "$problems" -gt 0 ]; then echo "🔴 инцидентов: $problems, предупреждений: $warns"; exit 1
elif [ "$warns" -gt 0 ]; then echo "⚠️  предупреждений: $warns, инцидентов нет"; exit 0
else echo "✅ всё в норме"; exit 0; fi
REMOTE
