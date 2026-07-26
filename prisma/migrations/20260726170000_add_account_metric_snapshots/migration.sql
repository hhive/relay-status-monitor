BEGIN;

CREATE TYPE "AccountMetricSnapshotWindow" AS ENUM ('TODAY', 'LAST_1H', 'LAST_24H');

CREATE TABLE "AccountMetricSnapshotBatch" (
  "id" SERIAL NOT NULL,
  "windowKey" "AccountMetricSnapshotWindow" NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "windowEnd" TIMESTAMP(3) NOT NULL,
  "lastCompleteMinute" TIMESTAMP(3),
  "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "active" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "AccountMetricSnapshotBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AccountMetricSnapshot" (
  "id" SERIAL NOT NULL,
  "batchId" INTEGER NOT NULL,
  "accountId" INTEGER NOT NULL,
  "successCount" INTEGER NOT NULL DEFAULT 0,
  "upstreamErrorCount" INTEGER NOT NULL DEFAULT 0,
  "eligibleCount" INTEGER NOT NULL DEFAULT 0,
  "availability" DOUBLE PRECISION,
  "errorRate" DOUBLE PRECISION,
  "durationP95Ms" DOUBLE PRECISION,
  "firstTokenP95Ms" DOUBLE PRECISION,
  "cacheHitRate" DOUBLE PRECISION,
  "userBilledUsd" DECIMAL(24,6) NOT NULL DEFAULT 0,
  "accountBilledUsd" DECIMAL(24,6) NOT NULL DEFAULT 0,
  "lastCompleteMinute" TIMESTAMP(3),
  CONSTRAINT "AccountMetricSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AccountMetricSnapshotBatch_windowKey_active_idx"
ON "AccountMetricSnapshotBatch"("windowKey", "active");

CREATE UNIQUE INDEX "AccountMetricSnapshotBatch_one_active_window"
ON "AccountMetricSnapshotBatch"("windowKey")
WHERE "active" = true;

CREATE UNIQUE INDEX "AccountMetricSnapshot_batchId_accountId_key"
ON "AccountMetricSnapshot"("batchId", "accountId");

CREATE INDEX "AccountMetricSnapshot_accountId_idx"
ON "AccountMetricSnapshot"("accountId");

ALTER TABLE "AccountMetricSnapshot"
ADD CONSTRAINT "AccountMetricSnapshot_batchId_fkey"
FOREIGN KEY ("batchId") REFERENCES "AccountMetricSnapshotBatch"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AccountMetricSnapshot"
ADD CONSTRAINT "AccountMetricSnapshot_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "Sub2ApiAccount"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
