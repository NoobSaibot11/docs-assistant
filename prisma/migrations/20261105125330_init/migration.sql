-- [hand-written] pgvector must exist before the "Chunk"."embedding" vector(1024) column is created.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "framework" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "docsVersion" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "framework" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "headingPath" TEXT NOT NULL,
    "anchor" TEXT,
    "content" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "embedding" vector(1024),

    CONSTRAINT "Chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "citations" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueryLog" (
    "id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "retrievalMode" TEXT NOT NULL,
    "frameworks" TEXT[],
    "topChunkIds" TEXT[],
    "topScore" DOUBLE PRECISION NOT NULL,
    "answered" BOOLEAN NOT NULL,
    "ttftMs" INTEGER NOT NULL,
    "totalMs" INTEGER NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheReadTokens" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QueryLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Document_framework_sourcePath_key" ON "Document"("framework", "sourcePath");

-- CreateIndex
CREATE INDEX "Chunk_framework_idx" ON "Chunk"("framework");

-- CreateIndex
CREATE UNIQUE INDEX "Chunk_documentId_ordinal_key" ON "Chunk"("documentId", "ordinal");

-- AddForeignKey
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- [hand-written] Things Prisma's schema language can't express.
-- ---------------------------------------------------------------------------

-- Full-text search column, kept in sync by Postgres on every insert/update.
ALTER TABLE "Chunk"
  ADD COLUMN "tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', "headingPath" || ' ' || "content")) STORED;

-- Keyword search (ts_rank over tsv).
CREATE INDEX "Chunk_tsv_idx" ON "Chunk" USING GIN ("tsv");

-- Approximate nearest-neighbour search with cosine distance (the <=> operator).
CREATE INDEX "Chunk_embedding_hnsw_idx" ON "Chunk" USING hnsw ("embedding" vector_cosine_ops);
