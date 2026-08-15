CREATE TABLE "RemoteBackupRecord" (
  "id" SERIAL NOT NULL,
  "status" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "fileName" TEXT,
  "fileSize" BIGINT,
  "deletedCount" INTEGER NOT NULL DEFAULT 0,
  "deletedFiles" JSONB,
  "errorMessage" TEXT,
  CONSTRAINT "RemoteBackupRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RemoteBackupRecord_startedAt_idx" ON "RemoteBackupRecord"("startedAt");
CREATE INDEX "RemoteBackupRecord_status_startedAt_idx" ON "RemoteBackupRecord"("status", "startedAt");
