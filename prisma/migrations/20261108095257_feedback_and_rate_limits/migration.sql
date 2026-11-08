-- AlterTable
ALTER TABLE "QueryLog" ADD COLUMN     "clientHash" TEXT;

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "queryLogId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Feedback_queryLogId_key" ON "Feedback"("queryLogId");

-- CreateIndex
CREATE INDEX "QueryLog_createdAt_idx" ON "QueryLog"("createdAt");

-- CreateIndex
CREATE INDEX "QueryLog_clientHash_createdAt_idx" ON "QueryLog"("clientHash", "createdAt");

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_queryLogId_fkey" FOREIGN KEY ("queryLogId") REFERENCES "QueryLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
