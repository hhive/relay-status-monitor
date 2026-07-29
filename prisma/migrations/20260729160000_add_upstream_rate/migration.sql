BEGIN;

ALTER TABLE "AccountMetricMinute"
  ADD COLUMN "baseBilledUsd" DECIMAL(24,6) NOT NULL DEFAULT 0,
  ADD COLUMN "upstreamKeyUsedUsd" DECIMAL(24,6),
  ADD COLUMN "upstreamKeyStandardUsd" DECIMAL(24,6),
  ADD COLUMN "upstreamRateMultiplier" DECIMAL(20,8),
  ADD COLUMN "upstreamRateSource" VARCHAR(16);

ALTER TABLE "AccountMetricSnapshot"
  ADD COLUMN "upstreamRateMultiplier" DECIMAL(20,8),
  ADD COLUMN "upstreamRateSource" VARCHAR(16);

COMMIT;
