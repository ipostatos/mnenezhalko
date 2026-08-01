#!/usr/bin/env bash
# Обход показаний прода. Запускается НА САМОМ СЕРВЕРЕ: руками, из scripts/observe.sh
# по SSH и из scripts/observe-alert.sh по таймеру. Пороги и реакции описаны
# в docs/OBSERVATION_GATE.md; здесь они продублированы значениями, потому что
# скрипт должен сам говорить «норма / предупреждение / инцидент», а не заставлять
# сверять числа глазами.
#
# Только читает: ни одной записи в базу, ни одного рестарта.
#
# Код возврата: 0 — норма или только предупреждения, 1 — есть инцидент.
#
# ⚠️ Строки «🔴» уходят администраторам в Telegram (observe-alert.sh), поэтому
# в них НЕ должно попадать ничего личного: ни имён, ни ников, ни идентификаторов,
# ни текстов, которые писал человек (названия книг, отзывы, причины ограничений).
# Подробности, где такое возможно, печатаем обычным `say` — он остаётся в отчёте
# и в journalctl, но в сообщение не идёт.
set -u

DIR="${DEPLOY_DIR:-/opt/mnenezhalko}"
PORT="${DEPLOY_PORT:-4310}"
BACKUPS="${OBSERVE_BACKUPS:-/opt/backups/mnenezhalko}"
DB="${OBSERVE_DB:-$DIR/shared/data/mnenezhalko.db}"
UNIT="${OBSERVE_UNIT:-mnenezhalko}"
# читаем только наличие настройки внешнего монитора, окружение службы целиком не тащим
ENV_FILE="${OBSERVE_ENV_FILE:-$DIR/shared/.env}"

q() { sqlite3 "$DB" "$1" 2>/dev/null || echo "?"; }
now=$(date -u +%s)
problems=0
warns=0

say()  { printf '  %s\n' "$1"; }
ok()   { printf '  ✅ %s\n' "$1"; }
warn() { printf '  ⚠️  %s\n' "$1"; warns=$((warns+1)); }
bad()  { printf '  🔴 %s\n' "$1"; problems=$((problems+1)); }

echo "════ процесс ════"
active=$(systemctl is-active "$UNIT" 2>/dev/null || true)
[ "$active" = "active" ] && ok "служба active" || bad "служба не active ($active)"
restarts=$(systemctl show "$UNIT" -p NRestarts --value 2>/dev/null || echo 0)
started=$(systemctl show "$UNIT" -p ActiveEnterTimestamp --value 2>/dev/null || echo '?')
# рестарт без выкладки — инцидент: systemd поднял упавший процесс
if [ "${restarts:-0}" -gt 0 ]; then
  bad "systemd перезапускал процесс: $restarts — причина в journalctl"
else
  ok "перезапусков процессом не было (NRestarts=0), поднят: $started"
fi
errs=$(journalctl -u "$UNIT" --since "24 hours ago" -p err --no-pager 2>/dev/null | grep -vc "No entries" || true)
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
if   [ "$free_mb" -lt 800 ];  then bad  "свободно ${free_mb} МБ — новые релизы не выкладывать (релиз ~354 МБ)"
elif [ "$free_mb" -lt 1536 ]; then warn "свободно ${free_mb} МБ — чистить imgcache и journalctl"
else ok "свободно $((free_mb/1024)),$(( (free_mb%1024)*10/1024 )) ГБ"; fi
say "база: $(du -h "$DB" 2>/dev/null | cut -f1), превью: $(du -sh "$DIR/shared/data/imgcache" 2>/dev/null | cut -f1), фото: $(du -sh "$DIR/shared/data/covers" 2>/dev/null | cut -f1)"
say "релизы: $(du -sh "$DIR/releases" 2>/dev/null | cut -f1) ($(ls "$DIR/releases" 2>/dev/null | wc -l) шт)"

echo "════ письма о решениях ════"
stuck=$(q "select count(*) from NotificationOutbox where sentAt is null and attempts>=3")
pending=$(q "select count(*) from NotificationOutbox where sentAt is null")
[ "$stuck" = "0" ] && ok "застрявших нет (в очереди $pending)" \
  || bad "не доставлено писем о решениях после трёх попыток: $stuck"
# текст ошибки доставки приходит от Telegram и может содержать чужое —
# поэтому обычной строкой, в сообщение админам он не пойдёт
lasterr=$(q "select lastError from NotificationOutbox where lastError is not null and lastError<>'' order by createdAt desc limit 1")
[ -n "$lasterr" ] && [ "$lasterr" != "?" ] && say "последняя ошибка доставки: $lasterr" || true

echo "════ модерация ════"
say "на проверке: $(q "select count(*) from Book where reviewStatus='pending'"), решений в журнале: $(q "select count(*) from ModerationAction")"
approving=$(q "select count(*) from Book where reviewStatus='approving' and approvalStartedAt < datetime('now','-30 minutes')")
[ "$approving" = "0" ] && ok "зависших в approving нет" \
  || bad "книг в approving дольше 30 минут: $approving — процесс падал посреди публикации"
say "скрытых отзывов: $(q "select count(*) from Review where status='hidden'"), ограничений: $(q "select count(*) from UserRestriction where liftedAt is null and (expiresAt is null or expiresAt > datetime('now'))"), заблокировано: $(q "select count(*) from User where accountStatus='banned'")"

echo "════ джобы планировщика ════"
# срок каждой джобы свой; здесь общее правило: два интервала без успеха это инцидент
while IFS='|' read -r key val; do
  [ -z "$key" ] && continue
  name="${key#job:}"; name="${name%:lastSuccessAt}"
  age=$(( (now - $(date -u -d "$val" +%s 2>/dev/null || echo "$now")) / 60 ))
  err=$(q "select value from SyncState where key='job:$name:lastError'")
  if [ -n "$err" ] && [ "$err" != "?" ]; then
    # сам текст ошибки может содержать пользовательское (название книги, ник),
    # поэтому в инцидент идёт только имя джобы, а текст — обычной строкой
    bad "джоба $name: ошибка (текст в journalctl)"
    say "    текст ошибки: $err"
  else
    say "$name: успех $age мин назад"
  fi
done <<< "$(q "select key, value from SyncState where key like 'job:%:lastSuccessAt' order by key")"

echo "════ Notion ════"
sync_at=$(q "select value from SyncState where key='notion'")
sync_age=$(( (now - $(date -u -d "$sync_at" +%s 2>/dev/null || echo "$now")) / 3600 ))
tok=$(q "select value from SyncState where key='notion:tokenOk'")
[ "$tok" = "1" ] && ok "cookie жива, синк $sync_age ч назад" || bad "cookie Notion не работает (tokenOk=$tok)"
# период синка 12 ч; два периода без успеха это уже не задержка
[ "$sync_age" -gt 24 ] && bad "синк Notion не проходил $sync_age ч (период 12 ч)" || true
alert=$(q "select value from SyncState where key='syncAlert'")
[ -n "$alert" ] && [ "$alert" != "?" ] && warn "предохранитель синка сработал" || true

echo "════ внешний монитор ════"
# Двое сторожат друг друга: этот скрипт не увидит смерть машины, а расписание
# GitHub не увидит собственного выключения (в публичном репозитории оно засыпает
# после 60 дней без коммитов, секрет можно случайно удалить). Тишина снаружи
# неотличима от «всё хорошо» — поэтому спрашиваем, когда к нам заходили.
mon_token=$(grep '^MONITOR_PING_TOKEN=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r')
age_of() { # ISO-время в минутах назад; пусто или мусор → -1
  if [ -z "$1" ] || [ "$1" = "?" ]; then echo -1; return; fi
  s=$(date -u -d "$1" +%s 2>/dev/null) || { echo -1; return; }
  echo $(( (now - s) / 60 ))
}
if [ -z "$mon_token" ]; then
  warn "внешний монитор не настроен (нет MONITOR_PING_TOKEN) — снаружи прод никто не проверяет"
else
  # Наблюдением считается ТОЛЬКО расписание: ручной прогон это диагностика,
  # и один такой прогон не должен маскировать выключенное расписание.
  sched_age=$(age_of "$(q "select value from SyncState where key='monitor:external:schedule'")")
  any_age=$(age_of "$(q "select value from SyncState where key='monitor:external'")")
  first_age=$(age_of "$(q "select value from SyncState where key='monitor:external:first'")")

  if [ "$sched_age" -ge 0 ]; then
    # расписание раз в 10 минут, но GitHub его не гарантирует: ночью 1 августа
    # реальный разрыв дошёл до 3 ч 25 мин при живом проде. Четыре часа тишины —
    # это уже не троттлинг очереди
    if [ "$sched_age" -gt 240 ]; then
      bad "внешний монитор не заходил по расписанию $sched_age мин — проверка снаружи не работает"
    else
      ok "внешний монитор заходил по расписанию $sched_age мин назад"
    fi
  elif [ "$first_age" -ge 1440 ]; then
    # заходы были, но ни одного по расписанию за сутки — значит расписание не работает,
    # а ручные прогоны только создают видимость наблюдения
    bad "расписание внешнего монитора не сработало ни разу за $(( first_age / 60 )) ч"
  else
    warn "внешний монитор по расписанию ещё не заходил (первый запуск GitHub раскачивает до часа)"
  fi
  [ "$any_age" -ge 0 ] && [ "$any_age" != "$sched_age" ] && say "последний заход любым способом: $any_age мин назад" || true
fi

echo "════ бэкап ════"
last=$(ls -t "$BACKUPS"/*.db.gz 2>/dev/null | head -1)
if [ -z "$last" ]; then bad "копий базы нет вовсе"
else
  age=$(( (now - $(stat -c %Y "$last")) / 3600 ))
  if [ "$age" -gt 26 ]; then bad "последний бэкап $age ч назад (cron в 3:34)"
  else ok "последняя копия $age ч назад: $(basename "$last") ($(ls "$BACKUPS" | wc -l) файлов)"; fi
fi

echo
if [ "$problems" -gt 0 ]; then echo "🔴 инцидентов: $problems, предупреждений: $warns"; exit 1
elif [ "$warns" -gt 0 ]; then echo "⚠️  предупреждений: $warns, инцидентов нет"; exit 0
else echo "✅ всё в норме"; exit 0; fi
