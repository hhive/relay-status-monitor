ALTER TABLE "Sub2ApiAccount"
ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 50;

ALTER TABLE "Sub2ApiAccount"
ADD CONSTRAINT "Sub2ApiAccount_priority_check" CHECK ("priority" >= 0);
