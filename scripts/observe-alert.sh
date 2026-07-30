#!/usr/bin/env bash
# Внутренний watchdog: раз в час прогоняет проверку (scripts/observe-local.sh)
# и пишет администраторам в Telegram, когда появился инцидент.
#
# ⚠️ Это ВНУТРЕННИЙ слой, а не мониторинг снаружи. Он видит зависшие письма,
# ошибки джоб, диск, бэкап, Notion и поднятый systemd'ом упавший процесс.
# Он НЕ увидит смерть всей машины, пропажу сети и поломку самого Telegram API:
# в этих случаях он просто не запустится или не сможет отправить сообщение.
# Внешний uptime-монитор — отдельный следующий этап (docs/MONITORING.md).
#
# Правила молчания (иначе одна и та же проблема будит людей каждый час):
#   норма → инцидент            — сообщение сразу
#   тот же инцидент продолжается — молчим, напоминание через 6 часов
#   набор инцидентов изменился   — сообщение сразу
#   инцидент → норма            — одно сообщение «восстановлено»
#
# Запуск: systemd timer mnenezhalko-observe.timer (см. scripts/mnenezhalko-observe.*)
# Проверить руками: bash scripts/observe-alert.sh
set -uo pipefail

DIR="${DEPLOY_DIR:-/opt/mnenezhalko}"
SHARED="${OBSERVE_SHARED:-$DIR/shared}"
STATE_DIR="${OBSERVE_STATE_DIR:-$SHARED/monitoring}"
STATE="$STATE_DIR/observe-state"
CHECK="${OBSERVE_CMD:-$DIR/current/scripts/observe-local.sh}"
ENV_FILE="${OBSERVE_ENV_FILE:-$SHARED/.env}"
RELEASE_ENV="${OBSERVE_RELEASE_ENV:-$DIR/current/server/.release-env}"
LOCK="${OBSERVE_LOCK:-/run/lock/mnenezhalko-observe.lock}"
# напоминание о неисправленном инциденте: 6 часов
REMIND_SECONDS="${OBSERVE_REMIND_SECONDS:-21600}"
API="${TELEGRAM_API:-https://api.telegram.org}"
NOW="${OBSERVE_NOW:-$(date +%s)}"

# ── один запуск за раз ──────────────────────────────────────
# Проверка ходит в systemctl, sqlite и curl; два параллельных прогона могут
# разойтись в выводе и прислать людям два разных сообщения об одном состоянии.
if [ -z "${OBSERVE_LOCKED:-}" ] && command -v flock >/dev/null 2>&1; then
  mkdir -p "$(dirname "$LOCK")" 2>/dev/null || true
  OBSERVE_LOCKED=1 flock -n -E 99 "$LOCK" "$0" "$@"
  rc=$?
  if [ "$rc" -eq 99 ]; then
    echo "предыдущая проверка ещё идёт — пропускаю запуск"
    exit 0
  fi
  exit "$rc"
fi

mkdir -p "$STATE_DIR" 2>/dev/null || true

# ── прогон проверки ─────────────────────────────────────────
report=$("$CHECK" 2>&1)
check_rc=$?
echo "$report"

# в сообщение идут ТОЛЬКО строки инцидентов; предупреждения и обычные строки
# остаются в journal — людей будят инциденты, а не полный отчёт
incidents=$(printf '%s\n' "$report" | grep '🔴' | grep -v '^🔴 инцидентов' | sed 's/^ *🔴 *//' || true)

# Отпечаток состояния: числа выбиты, потому что «бэкап 29 ч назад» и «30 ч назад» —
# ОДИН И ТОТ ЖЕ инцидент, а не новый; иначе напоминание приходило бы каждый час
# под видом «набор изменился».
fingerprint=$(printf '%s\n' "$incidents" | sed 's/[0-9][0-9]*/N/g' | sort | sha256sum | cut -c1-16)
[ -z "$incidents" ] && fingerprint=ok

prev_fingerprint=ok
prev_since="$NOW"
prev_sent=0
# shellcheck source=/dev/null
[ -f "$STATE" ] && . "$STATE"

save_state() {
  printf 'prev_fingerprint=%s\nprev_since=%s\nprev_sent=%s\n' "$1" "$2" "$3" > "$STATE"
}

# ── отправка ────────────────────────────────────────────────
# ADMIN_IDS и BOT_TOKEN берём из того же .env, что и служба. Файл читается
# построчно: незачем тащить в этот скрипт всё окружение службы.
read_env() { grep "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r'; }

send_to_admins() {
  local text="$1" token ids id sent=0 failed=0
  token=$(read_env BOT_TOKEN)
  ids=$(read_env ADMIN_IDS)
  [ -n "${OBSERVE_ADMIN_IDS:-}" ] && ids="$OBSERVE_ADMIN_IDS"
  if [ -z "$token" ] || [ -z "$ids" ]; then
    echo "watchdog: некому писать (нет BOT_TOKEN или ADMIN_IDS) — сообщение только в journal"
    return 0
  fi
  # каждому админу независимо: недоставка одному не отменяет остальных
  for id in $(printf '%s' "$ids" | tr ',' ' '); do
    if [ -n "${OBSERVE_SEND_CMD:-}" ]; then
      printf '%s' "$text" | OBSERVE_CHAT_ID="$id" sh -c "$OBSERVE_SEND_CMD" && sent=$((sent+1)) || failed=$((failed+1))
      continue
    fi
    if curl -sS --max-time 15 -o /dev/null \
        "$API/bot$token/sendMessage" \
        --data-urlencode "chat_id=$id" \
        --data-urlencode "text=$text" \
        --data-urlencode "disable_web_page_preview=true" 2>/dev/null; then
      sent=$((sent+1))
    else
      # Telegram недоступен или бот заблокирован этим админом: пишем в journal
      # и продолжаем. Падать нельзя — иначе таймер уйдёт в failed-состояние
      echo "watchdog: не смог написать админу $id"
      failed=$((failed+1))
    fi
  done
  echo "watchdog: отправлено $sent, не удалось $failed"
  return 0
}

# заголовок и тело собираем без личных данных: только агрегаты и техника
build_message() {
  local kind="$1" sha ver stamp body
  sha=$(grep '^RELEASE_SHA=' "$RELEASE_ENV" 2>/dev/null | cut -d= -f2 | cut -c1-7)
  ver=$(grep '^RELEASE_VERSION=' "$RELEASE_ENV" 2>/dev/null | cut -d= -f2)
  stamp=$(TZ=Europe/Warsaw date -d "@$NOW" '+%d.%m.%Y %H:%M' 2>/dev/null || echo '?')

  if [ "$kind" = recovery ]; then
    printf '✅ МнеНеЖалко: наблюдение снова в норме\n\nИнцидентов нет.\n\nРелиз: %s\nВерсия: %s\nВремя: %s Europe/Warsaw\n' \
      "${sha:-?}" "${ver:-?}" "$stamp"
    return
  fi

  body=$(printf '%s\n' "$incidents" | sed 's/^/• /')
  local head='🔴 МнеНеЖалко: инцидент наблюдения'
  if [ "$kind" = reminder ]; then
    head=$(printf '🔴 МнеНеЖалко: инцидент не решён %s ч' "$(( (NOW - prev_since) / 3600 ))")
  fi
  printf '%s\n\n%s\n\nРелиз: %s\nВерсия: %s\nВремя: %s Europe/Warsaw\n\nПроверка:\nsystemctl status mnenezhalko\njournalctl -u mnenezhalko -n 100\n' \
    "$head" "$body" "${sha:-?}" "${ver:-?}" "$stamp"
}

# ── решение, писать или молчать ─────────────────────────────
if [ -z "$incidents" ]; then
  if [ "$prev_fingerprint" != ok ]; then
    send_to_admins "$(build_message recovery)"
    echo "watchdog: инцидент закрыт, отправлено восстановление"
  else
    echo "watchdog: норма, молчу"
  fi
  save_state ok "$NOW" 0
  exit 0
fi

if [ "$fingerprint" != "$prev_fingerprint" ]; then
  # новый инцидент или изменившийся набор — сообщаем сразу
  send_to_admins "$(build_message alert)"
  echo "watchdog: инцидент (набор изменился), отправлено"
  save_state "$fingerprint" "$NOW" "$NOW"
  exit "$check_rc"
fi

if [ $((NOW - prev_sent)) -ge "$REMIND_SECONDS" ]; then
  send_to_admins "$(build_message reminder)"
  echo "watchdog: тот же инцидент, отправлено напоминание"
  save_state "$fingerprint" "$prev_since" "$NOW"
  exit "$check_rc"
fi

echo "watchdog: тот же инцидент, о нём уже писали — молчу"
save_state "$fingerprint" "$prev_since" "$prev_sent"
exit "$check_rc"
