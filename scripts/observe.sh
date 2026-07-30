#!/usr/bin/env bash
# Обход показаний прода с рабочей машины (см. docs/OBSERVATION_GATE.md).
#
# Сама проверка живёт в scripts/observe-local.sh и выполняется НА СЕРВЕРЕ: её же
# запускает почасовой watchdog (scripts/observe-alert.sh). Здесь только SSH-обёртка,
# чтобы не держать две копии проверок, которые разойдутся.
#
# Запуск: bash scripts/observe.sh
# С Windows домен sslip.io не резолвится, поэтому читаем по SSH с самой машины.
#
# Код возврата тот же, что у проверки: 0 — норма или предупреждения, 1 — инцидент.
set -uo pipefail

HOST="${DEPLOY_HOST:-root@46.224.220.94}"
DIR="${DEPLOY_DIR:-/opt/mnenezhalko}"
PORT="${DEPLOY_PORT:-4310}"

ssh "$HOST" "DEPLOY_DIR='$DIR' DEPLOY_PORT='$PORT' bash '$DIR/current/scripts/observe-local.sh'"
