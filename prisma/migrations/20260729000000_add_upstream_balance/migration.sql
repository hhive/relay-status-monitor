BEGIN;

ALTER TABLE "AccountMetricMinute"
  ADD COLUMN "balanceUsd" DECIMAL(24,6);

ALTER TABLE "AccountMetricSnapshot"
  ADD COLUMN "balanceUsd" DECIMAL(24,6);

INSERT INTO "AccountAlertRule" (
  "name", "metric", "operator", "threshold", "severity",
  "minRequests", "minPromptTokens", "cooldownMin", "enabled", "createdAt", "updatedAt"
)
VALUES (
  '上游余额低', 'balance_low', 'lte', 5, 'WARNING',
  0, 0, 0, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
ON CONFLICT ("name") DO NOTHING;

COMMIT;
