-- DropIndex
DROP INDEX "Event_sourceMsgId_key";

-- AlterTable
ALTER TABLE "Event" ADD COLUMN "sourceEventIndex" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Event_sourceMsgId_sourceEventIndex_key" ON "Event"("sourceMsgId", "sourceEventIndex");


-- Backfill: у существующих встреч из афиш индекс события в сообщении — 0,
-- чтобы повторный разбор того же сообщения не создал дубль первой встречи.
UPDATE "Event" SET "sourceEventIndex" = 0 WHERE "sourceMsgId" IS NOT NULL;
