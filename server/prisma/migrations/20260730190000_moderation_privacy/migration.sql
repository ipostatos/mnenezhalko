-- P1.1: сведение модерации с приватностью и надёжная доставка уведомлений.
--   * ModerationAction.actorTg становится NULL-able, добавляются targetHash/actorHash:
--     после удаления данных в журнале остаётся факт решения, но не сырой Telegram id;
--   * NotificationOutbox: решение и письмо человеку пишутся ОДНОЙ транзакцией,
--     отправкой занимается фоновая джоба.

-- CreateTable
CREATE TABLE "NotificationOutbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipientTg" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ModerationAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorTg" BIGINT,
    "targetUserTg" BIGINT,
    "targetHash" TEXT,
    "actorHash" TEXT,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "meta" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_ModerationAction" ("action", "actorTg", "createdAt", "id", "meta", "reason", "targetId", "targetType", "targetUserTg") SELECT "action", "actorTg", "createdAt", "id", "meta", "reason", "targetId", "targetType", "targetUserTg" FROM "ModerationAction";
DROP TABLE "ModerationAction";
ALTER TABLE "new_ModerationAction" RENAME TO "ModerationAction";
CREATE INDEX "ModerationAction_targetUserTg_createdAt_idx" ON "ModerationAction"("targetUserTg", "createdAt");
CREATE INDEX "ModerationAction_targetType_targetId_idx" ON "ModerationAction"("targetType", "targetId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "NotificationOutbox_sentAt_createdAt_idx" ON "NotificationOutbox"("sentAt", "createdAt");

