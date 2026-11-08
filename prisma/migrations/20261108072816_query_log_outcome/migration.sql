-- AlterTable
ALTER TABLE "QueryLog" ADD COLUMN     "outcome" TEXT NOT NULL DEFAULT 'answered',
ADD COLUMN     "rewriteInputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rewriteOutputTokens" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "ttftMs" DROP NOT NULL;
