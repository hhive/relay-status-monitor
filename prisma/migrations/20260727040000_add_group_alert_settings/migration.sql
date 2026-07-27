CREATE TABLE "GroupAlertSetting" (
    "groupId" INTEGER NOT NULL,
    "alertEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupAlertSetting_pkey" PRIMARY KEY ("groupId"),
    CONSTRAINT "GroupAlertSetting_groupId_check" CHECK ("groupId" > 0)
);
