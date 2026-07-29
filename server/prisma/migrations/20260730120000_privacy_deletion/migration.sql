-- Приватность: право забрать и удалить свои данные.
--   * DeletionRequest — журнал исполненных удалений (только ХЭШ id, см. mydata.ts),
--     чтобы повторно применить их после восстановления старой резервной копии;
--   * Loan.ownerTg становится NULL-able: у ЗАКРЫТОЙ выдачи удалившегося владельца
--     остаётся история обмена без возможности опознать человека.

-- CreateTable
CREATE TABLE "DeletionRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tgHash" TEXT NOT NULL,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "summary" TEXT
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Loan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "bookId" TEXT,
    "ownerTg" BIGINT,
    "holderUsername" TEXT,
    "holderName" TEXT,
    "holderTg" BIGINT,
    "activeBookId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "takenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" DATETIME,
    "returnedAt" DATETIME,
    "remindedAt" DATETIME,
    "note" TEXT,
    "claimTokenHash" TEXT,
    "claimTokenExpiresAt" DATETIME,
    CONSTRAINT "Loan_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Loan_ownerTg_fkey" FOREIGN KEY ("ownerTg") REFERENCES "User" ("tgId") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Loan_holderTg_fkey" FOREIGN KEY ("holderTg") REFERENCES "User" ("tgId") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Loan" ("activeBookId", "bookId", "claimTokenExpiresAt", "claimTokenHash", "dueAt", "holderName", "holderTg", "holderUsername", "id", "note", "ownerTg", "remindedAt", "returnedAt", "status", "takenAt", "title") SELECT "activeBookId", "bookId", "claimTokenExpiresAt", "claimTokenHash", "dueAt", "holderName", "holderTg", "holderUsername", "id", "note", "ownerTg", "remindedAt", "returnedAt", "status", "takenAt", "title" FROM "Loan";
DROP TABLE "Loan";
ALTER TABLE "new_Loan" RENAME TO "Loan";
CREATE UNIQUE INDEX "Loan_claimTokenHash_key" ON "Loan"("claimTokenHash");
CREATE INDEX "Loan_ownerTg_status_idx" ON "Loan"("ownerTg", "status");
CREATE INDEX "Loan_holderTg_status_idx" ON "Loan"("holderTg", "status");
CREATE UNIQUE INDEX "Loan_activeBookId_key" ON "Loan"("activeBookId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "DeletionRequest_tgHash_key" ON "DeletionRequest"("tgHash");

