-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Book" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "notionId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'book',
    "title" TEXT NOT NULL,
    "author" TEXT,
    "genres" TEXT NOT NULL DEFAULT '',
    "languages" TEXT NOT NULL DEFAULT '',
    "city" TEXT,
    "district" TEXT,
    "coverUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'free',
    "addedAt" DATETIME,
    "source" TEXT NOT NULL DEFAULT 'notion',
    "notionStatus" TEXT NOT NULL DEFAULT 'local',
    "notionError" TEXT,
    "reviewStatus" TEXT NOT NULL DEFAULT 'approved',
    "reviewedByTg" BIGINT,
    "reviewedAt" DATETIME,
    "approvalStartedAt" DATETIME,
    "approvalStartedByTg" BIGINT,
    "approvalAttempt" INTEGER NOT NULL DEFAULT 0,
    "rejectionReason" TEXT,
    "submittedAt" DATETIME,
    "deletedAt" DATETIME,
    "deletedByTg" BIGINT,
    "hideAfterReturn" BOOLEAN NOT NULL DEFAULT false,
    "notionArchivePending" BOOLEAN NOT NULL DEFAULT false,
    "addedByTg" BIGINT,
    "search" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "ownerId" TEXT,
    CONSTRAINT "Book_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Librarian" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Book" ("active", "addedAt", "addedByTg", "author", "city", "coverUrl", "createdAt", "deletedAt", "deletedByTg", "district", "genres", "hideAfterReturn", "id", "kind", "languages", "notionArchivePending", "notionError", "notionId", "notionStatus", "ownerId", "rejectionReason", "reviewStatus", "reviewedAt", "reviewedByTg", "search", "source", "status", "submittedAt", "title", "updatedAt") SELECT "active", "addedAt", "addedByTg", "author", "city", "coverUrl", "createdAt", "deletedAt", "deletedByTg", "district", "genres", "hideAfterReturn", "id", "kind", "languages", "notionArchivePending", "notionError", "notionId", "notionStatus", "ownerId", "rejectionReason", "reviewStatus", "reviewedAt", "reviewedByTg", "search", "source", "status", "submittedAt", "title", "updatedAt" FROM "Book";
DROP TABLE "Book";
ALTER TABLE "new_Book" RENAME TO "Book";
CREATE UNIQUE INDEX "Book_notionId_key" ON "Book"("notionId");
CREATE INDEX "Book_kind_idx" ON "Book"("kind");
CREATE INDEX "Book_city_idx" ON "Book"("city");
CREATE INDEX "Book_ownerId_idx" ON "Book"("ownerId");
CREATE INDEX "Book_reviewStatus_idx" ON "Book"("reviewStatus");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
