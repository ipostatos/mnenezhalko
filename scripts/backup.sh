#!/bin/sh
# Бэкап базы и обложек.
#
# В mnenezhalko.db лежат выдачи («у кого моя книга»), карточки, добавленные
# ботом, и подписки на анонсы — из Notion это не восстанавливается.
# Обложки важны не меньше: общая таблица проекта в Notion ссылается на них
# внешними ссылками на наш сервер, потеряем файлы — картинки отвалятся у всех.
#
# Копировать файл базы на живой SQLite нельзя (в момент копии может идти
# запись, снимок окажется битым) — только `.backup` под блокировкой.
#
# Ставится в cron на VPS:
#   crontab -e
#   34 3 * * * /opt/mnenezhalko/scripts/backup.sh >> /var/log/mnenezhalko-backup.log 2>&1
set -eu

DIR=/opt/mnenezhalko/server
DEST=/opt/backups/mnenezhalko
KEEP_DAYS=14

mkdir -p "$DEST"
chmod 700 "$DEST"

STAMP=$(date +%Y%m%d-%H%M)
OUT="$DEST/mnenezhalko-$STAMP.db"

# у sqlite3 нет зависимостей и он уже есть в системе; .backup даёт
# консистентный снимок, даже если бот в этот момент пишет
sqlite3 "$DIR/data/mnenezhalko.db" ".backup '$OUT'"
gzip -f "$OUT"
chmod 600 "$OUT.gz"
find "$DEST" -name 'mnenezhalko-*.db.gz' -mtime +"$KEEP_DAYS" -delete

# обложки: инкремента не делаем, их немного и архив жмётся до мегабайтов
COVERS="$DEST/covers-$STAMP.tar.gz"
tar -czf "$COVERS" -C "$DIR/data" covers
chmod 600 "$COVERS"
find "$DEST" -name 'covers-*.tar.gz' -mtime +"$KEEP_DAYS" -delete

# .env отдельно: без BOT_TOKEN и NOTION_TOKEN_V2 база сама по себе бесполезна
cp "$DIR/.env" "$DEST/env-$STAMP.bak"
chmod 600 "$DEST/env-$STAMP.bak"
find "$DEST" -name 'env-*.bak' -mtime +"$KEEP_DAYS" -delete

echo "$(date -Iseconds) ok: база $(du -h "$OUT.gz" | cut -f1), обложки $(du -h "$COVERS" | cut -f1)"
