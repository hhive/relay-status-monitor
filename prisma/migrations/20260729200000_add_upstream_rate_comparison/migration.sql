BEGIN;

ALTER TABLE "AccountMetricMinute"
  ADD COLUMN "upstreamEstimatedRateMultiplier" DECIMAL(20,8);

ALTER TABLE "AccountMetricSnapshot"
  ADD COLUMN "upstreamEstimatedRateMultiplier" DECIMAL(20,8);

INSERT INTO "AccountAlertRule" (
  "name", "metric", "operator", "threshold", "severity",
  "minRequests", "minPromptTokens", "cooldownMin", "enabled", "createdAt", "updatedAt"
)
VALUES (
  '上游倍率偏差高', 'upstream_rate_deviation', 'gt', 0.10, 'WARNING',
  0, 0, 30, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
ON CONFLICT ("name") DO NOTHING;

COMMIT;
