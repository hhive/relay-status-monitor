BEGIN;

-- 账号告警总开关：默认开启，现有账号回填为 true，保持既有告警行为
ALTER TABLE "Sub2ApiAccount" ADD COLUMN "alertEnabled" BOOLEAN NOT NULL DEFAULT true;

COMMIT;
