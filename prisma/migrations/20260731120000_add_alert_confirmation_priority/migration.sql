CREATE TABLE "AccountAlertCandidate" (
  "accountId" INTEGER NOT NULL,
  "ruleId" INTEGER NOT NULL,
  "windowStartedAt" TIMESTAMP(3) NOT NULL,
  "lastTriggeredAt" TIMESTAMP(3) NOT NULL,
  "triggerCount" INTEGER NOT NULL DEFAULT 1,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "adjustmentLevel" INTEGER NOT NULL DEFAULT 0,
  "recoveryNormalCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AccountAlertCandidate_pkey" PRIMARY KEY ("accountId", "ruleId"),
  CONSTRAINT "AccountAlertCandidate_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Sub2ApiAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AccountAlertCandidate_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AccountAlertRule"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AccountAlertCandidate_count_check" CHECK ("triggerCount" >= 0 AND "adjustmentLevel" >= 0 AND "recoveryNormalCount" BETWEEN 0 AND 3)
);

CREATE TABLE "AccountPriorityAdjustment" (
  "accountId" INTEGER NOT NULL,
  "sourceAccountId" TEXT NOT NULL,
  "expectedPriority" INTEGER,
  "basePriority" INTEGER,
  "adjustedPriority" INTEGER,
  "restoreExpectedPriority" INTEGER,
  "restoreTargetPriority" INTEGER,
  "appliedFactors" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "factor" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AccountPriorityAdjustment_pkey" PRIMARY KEY ("accountId"),
  CONSTRAINT "AccountPriorityAdjustment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Sub2ApiAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AccountPriorityAdjustment_priority_check" CHECK (
    ("expectedPriority" IS NULL OR "expectedPriority" >= 0) AND
    ("basePriority" IS NULL OR "basePriority" >= 1) AND
    ("adjustedPriority" IS NULL OR "adjustedPriority" >= 1) AND
    ("restoreExpectedPriority" IS NULL OR "restoreExpectedPriority" >= 0) AND
    ("restoreTargetPriority" IS NULL OR "restoreTargetPriority" >= 1) AND
    "factor" >= 0
  )
);
