-- CreateTable
CREATE TABLE "Waiting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "userTg" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" DATETIME,
    "notifiedAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leftAt" DATETIME,
    CONSTRAINT "Waiting_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Waiting_userTg_fkey" FOREIGN KEY ("userTg") REFERENCES "User" ("tgId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Waiting_status_readyAt_idx" ON "Waiting"("status", "readyAt");

-- CreateIndex
CREATE INDEX "Waiting_bookId_status_createdAt_idx" ON "Waiting"("bookId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Waiting_userTg_status_idx" ON "Waiting"("userTg", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Waiting_bookId_userTg_key" ON "Waiting"("bookId", "userTg");
