CREATE TYPE "AccountSchedulingActionType" AS ENUM (
  'PRIORITY_ADJUST',
  'PRIORITY_RESTORE',
  'PRIORITY_CAP_PAUSE'
);

CREATE TYPE "AccountSchedulingActionResult" AS ENUM (
  'SUCCESS',
  'FAILURE',
  'SAFE_SKIP'
);

CREATE TABLE "OperationalAlertRule" (
  "id" SERIAL NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "severity" "Severity" NOT NULL DEFAULT 'CRITICAL',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OperationalAlertRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OperationalAlertEvent" (
  "id" SERIAL NOT NULL,
  "ruleId" INTEGER NOT NULL,
  "subjectKey" TEXT NOT NULL,
  "subjectName" TEXT NOT NULL,
  "detail" TEXT NOT NULL,
  "recoveryDetail" TEXT,
  "severity" "Severity" NOT NULL DEFAULT 'CRITICAL',
  "firstTriggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastFailedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "failureCount" INTEGER NOT NULL DEFAULT 1,
  "resolved" BOOLEAN NOT NULL DEFAULT false,
  "resolvedAt" TIMESTAMP(3),
  "notificationDeliveries" JSONB,
  CONSTRAINT "OperationalAlertEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AccountSchedulingActionRecord" (
  "id" SERIAL NOT NULL,
  "accountId" INTEGER,
  "sourceAccountId" TEXT NOT NULL,
  "accountName" TEXT NOT NULL,
  "actionType" "AccountSchedulingActionType" NOT NULL,
  "result" "AccountSchedulingActionResult" NOT NULL,
  "priorityBefore" INTEGER,
  "priorityAfter" INTEGER,
  "factor" INTEGER,
  "conflictRecomputed" BOOLEAN NOT NULL DEFAULT false,
  "pausedUntil" TIMESTAMP(3),
  "reasonCode" TEXT,
  "errorCode" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountSchedulingActionRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OperationalAlertRule_key_key" ON "OperationalAlertRule"("key");
CREATE INDEX "OperationalAlertRule_enabled_key_idx" ON "OperationalAlertRule"("enabled", "key");
CREATE INDEX "OperationalAlertEvent_ruleId_subjectKey_resolved_idx" ON "OperationalAlertEvent"("ruleId", "subjectKey", "resolved");
CREATE INDEX "OperationalAlertEvent_resolved_firstTriggeredAt_idx" ON "OperationalAlertEvent"("resolved", "firstTriggeredAt");
CREATE INDEX "OperationalAlertEvent_severity_firstTriggeredAt_idx" ON "OperationalAlertEvent"("severity", "firstTriggeredAt");
CREATE UNIQUE INDEX "OperationalAlertEvent_one_open_subject_key"
  ON "OperationalAlertEvent"("ruleId", "subjectKey") WHERE "resolved" = false;
CREATE INDEX "AccountSchedulingActionRecord_accountId_occurredAt_idx" ON "AccountSchedulingActionRecord"("accountId", "occurredAt");
CREATE INDEX "AccountSchedulingActionRecord_actionType_occurredAt_idx" ON "AccountSchedulingActionRecord"("actionType", "occurredAt");
CREATE INDEX "AccountSchedulingActionRecord_result_occurredAt_idx" ON "AccountSchedulingActionRecord"("result", "occurredAt");
CREATE INDEX "AccountSchedulingActionRecord_occurredAt_idx" ON "AccountSchedulingActionRecord"("occurredAt");

ALTER TABLE "OperationalAlertEvent"
  ADD CONSTRAINT "OperationalAlertEvent_ruleId_fkey"
  FOREIGN KEY ("ruleId") REFERENCES "OperationalAlertRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountSchedulingActionRecord"
  ADD CONSTRAINT "AccountSchedulingActionRecord_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Sub2ApiAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "OperationalAlertRule" ("key", "name", "description", "severity", "enabled", "updatedAt")
VALUES
  ('collection_failed', '采集失败', '完整采集周期执行失败', 'CRITICAL', true, CURRENT_TIMESTAMP),
  ('priority_adjustment_failed', '优先级调整失败', 'Sub2API 账号优先级调整或恢复失败', 'CRITICAL', true, CURRENT_TIMESTAMP),
  ('priority_cap_pause_failed', '暂停账号失败', '优先级封顶后的账号临时暂停失败', 'CRITICAL', true, CURRENT_TIMESTAMP),
  ('remote_backup_failed', '远程备份失败', '已启用且到期的远程备份执行失败', 'CRITICAL', true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
