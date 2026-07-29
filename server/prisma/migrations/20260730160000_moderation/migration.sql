-- Модерация участников:
--   * User.accountStatus/bannedAt/bannedByTg/banReason — глобальное состояние;
--   * UserRestriction — точечный запрет на одно действие, со сроком и историей;
--   * ModerationAction — неизменяемый журнал решений модераторов.
-- «Ограничен» отдельным полем не хранится: вычисляется по действующим UserRestriction.

-- CreateTable
CREATE TABLE "UserRestriction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userTg" BIGINT NOT NULL,
    "scope" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdByTg" BIGINT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "liftedAt" DATETIME,
    "liftedByTg" BIGINT,
    CONSTRAINT "UserRestriction_userTg_fkey" FOREIGN KEY ("userTg") REFERENCES "User" ("tgId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModerationAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorTg" BIGINT NOT NULL,
    "targetUserTg" BIGINT,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "meta" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "tgId" BIGINT NOT NULL PRIMARY KEY,
    "username" TEXT,
    "firstName" TEXT,
    "lang" TEXT NOT NULL DEFAULT 'ru',
    "city" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "eventAlerts" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accountStatus" TEXT NOT NULL DEFAULT 'active',
    "bannedAt" DATETIME,
    "bannedByTg" BIGINT,
    "banReason" TEXT
);
INSERT INTO "new_User" ("city", "createdAt", "eventAlerts", "firstName", "isAdmin", "lang", "seenAt", "tgId", "username") SELECT "city", "createdAt", "eventAlerts", "firstName", "isAdmin", "lang", "seenAt", "tgId", "username" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "UserRestriction_userTg_scope_liftedAt_idx" ON "UserRestriction"("userTg", "scope", "liftedAt");

-- CreateIndex
CREATE INDEX "ModerationAction_targetUserTg_createdAt_idx" ON "ModerationAction"("targetUserTg", "createdAt");

-- CreateIndex
CREATE INDEX "ModerationAction_targetType_targetId_idx" ON "ModerationAction"("targetType", "targetId");

