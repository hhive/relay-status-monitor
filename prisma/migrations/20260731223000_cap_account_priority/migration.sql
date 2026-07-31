UPDATE "AccountPriorityAdjustment" AS adjustment
SET
  "expectedPriority" = NULL,
  "basePriority" = NULL,
  "adjustedPriority" = NULL,
  "restoreExpectedPriority" = NULL,
  "restoreTargetPriority" = NULL,
  "appliedFactors" = ARRAY[]::INTEGER[],
  "status" = 'RESTORED',
  "lastError" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "Sub2ApiAccount" AS account
WHERE adjustment."accountId" = account.id
  AND account."priority" > 1000000;

UPDATE "Sub2ApiAccount"
SET "priority" = 1000000
WHERE "priority" > 1000000;

ALTER TABLE "Sub2ApiAccount"
  DROP CONSTRAINT IF EXISTS "Sub2ApiAccount_priority_check";

ALTER TABLE "Sub2ApiAccount"
  ADD CONSTRAINT "Sub2ApiAccount_priority_check"
  CHECK ("priority" >= 0 AND "priority" <= 1000000);
