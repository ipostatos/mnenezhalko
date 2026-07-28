-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workKey" TEXT NOT NULL,
    "bookId" TEXT,
    "authorTg" BIGINT NOT NULL,
    "rating" INTEGER NOT NULL,
    "text" TEXT,
    "status" TEXT NOT NULL DEFAULT 'visible',
    "reports" INTEGER NOT NULL DEFAULT 0,
    "hiddenAt" DATETIME,
    "hiddenByTg" BIGINT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Review_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Review_authorTg_fkey" FOREIGN KEY ("authorTg") REFERENCES "User" ("tgId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkRating" (
    "workKey" TEXT NOT NULL PRIMARY KEY,
    "count" INTEGER NOT NULL DEFAULT 0,
    "sum" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Review_workKey_status_idx" ON "Review"("workKey", "status");

-- CreateIndex
CREATE INDEX "Review_authorTg_idx" ON "Review"("authorTg");

-- CreateIndex
CREATE UNIQUE INDEX "Review_workKey_authorTg_key" ON "Review"("workKey", "authorTg");

