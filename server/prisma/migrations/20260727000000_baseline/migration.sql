-- CreateTable
CREATE TABLE "User" (
    "tgId" BIGINT NOT NULL PRIMARY KEY,
    "username" TEXT,
    "firstName" TEXT,
    "lang" TEXT NOT NULL DEFAULT 'ru',
    "city" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "eventAlerts" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Librarian" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "notionId" TEXT,
    "name" TEXT NOT NULL,
    "telegram" TEXT,
    "telegramNorm" TEXT,
    "instagram" TEXT,
    "city" TEXT,
    "district" TEXT,
    "tgId" BIGINT,
    "mergedIntoId" TEXT,
    "lastTelegramSyncAt" DATETIME,
    "telegramSyncPending" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Librarian_tgId_fkey" FOREIGN KEY ("tgId") REFERENCES "User" ("tgId") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Book" (
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
    "rejectionReason" TEXT,
    "submittedAt" DATETIME,
    "deletedAt" DATETIME,
    "deletedByTg" BIGINT,
    "hideAfterReturn" BOOLEAN NOT NULL DEFAULT false,
    "addedByTg" BIGINT,
    "search" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "ownerId" TEXT,
    CONSTRAINT "Book_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Librarian" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "bookId" TEXT,
    "ownerTg" BIGINT NOT NULL,
    "holderUsername" TEXT,
    "holderName" TEXT,
    "holderTg" BIGINT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "takenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" DATETIME,
    "returnedAt" DATETIME,
    "remindedAt" DATETIME,
    "note" TEXT,
    "claimTokenHash" TEXT,
    "claimTokenExpiresAt" DATETIME,
    CONSTRAINT "Loan_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Loan_ownerTg_fkey" FOREIGN KEY ("ownerTg") REFERENCES "User" ("tgId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Loan_holderTg_fkey" FOREIGN KEY ("holderTg") REFERENCES "User" ("tgId") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LoanEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "loanId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "byTg" BIGINT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meta" TEXT,
    CONSTRAINT "LoanEvent_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CityGroup" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "city" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'chat',
    "sort" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "city" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startsAt" DATETIME NOT NULL,
    "place" TEXT,
    "description" TEXT,
    "url" TEXT,
    "source" TEXT NOT NULL DEFAULT 'admin',
    "sourceMsgId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" BIGINT,
    CONSTRAINT "Event_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User" ("tgId") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MarketItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "city" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'give',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "price" TEXT,
    "photo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "source" TEXT NOT NULL DEFAULT 'bot',
    "sourceMsgId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bumpedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "authorTg" BIGINT NOT NULL,
    "authorUsername" TEXT,
    CONSTRAINT "MarketItem_authorTg_fkey" FOREIGN KEY ("authorTg") REFERENCES "User" ("tgId") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncState" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Librarian_notionId_key" ON "Librarian"("notionId");

-- CreateIndex
CREATE UNIQUE INDEX "Librarian_tgId_key" ON "Librarian"("tgId");

-- CreateIndex
CREATE INDEX "Librarian_city_idx" ON "Librarian"("city");

-- CreateIndex
CREATE INDEX "Librarian_telegramNorm_idx" ON "Librarian"("telegramNorm");

-- CreateIndex
CREATE UNIQUE INDEX "Book_notionId_key" ON "Book"("notionId");

-- CreateIndex
CREATE INDEX "Book_kind_idx" ON "Book"("kind");

-- CreateIndex
CREATE INDEX "Book_city_idx" ON "Book"("city");

-- CreateIndex
CREATE INDEX "Book_ownerId_idx" ON "Book"("ownerId");

-- CreateIndex
CREATE INDEX "Book_reviewStatus_idx" ON "Book"("reviewStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Loan_claimTokenHash_key" ON "Loan"("claimTokenHash");

-- CreateIndex
CREATE INDEX "Loan_ownerTg_status_idx" ON "Loan"("ownerTg", "status");

-- CreateIndex
CREATE INDEX "Loan_holderTg_status_idx" ON "Loan"("holderTg", "status");

-- CreateIndex
CREATE INDEX "LoanEvent_loanId_idx" ON "LoanEvent"("loanId");

-- CreateIndex
CREATE INDEX "CityGroup_city_idx" ON "CityGroup"("city");

-- CreateIndex
CREATE UNIQUE INDEX "Event_sourceMsgId_key" ON "Event"("sourceMsgId");

-- CreateIndex
CREATE INDEX "Event_city_startsAt_idx" ON "Event"("city", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketItem_sourceMsgId_key" ON "MarketItem"("sourceMsgId");

-- CreateIndex
CREATE INDEX "MarketItem_city_status_bumpedAt_idx" ON "MarketItem"("city", "status", "bumpedAt");

