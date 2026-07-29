CREATE TYPE "AccountBalanceMode" AS ENUM ('AUTO', 'SUB2API', 'NEWAPI');

CREATE TABLE "AccountBalanceCredential" (
    "id" SERIAL NOT NULL,
    "accountId" INTEGER NOT NULL,
    "mode" "AccountBalanceMode" NOT NULL DEFAULT 'AUTO',
    "newApiUserId" TEXT,
    "newApiAccessTokenCiphertext" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AccountBalanceCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountBalanceCredential_accountId_key"
ON "AccountBalanceCredential"("accountId");

ALTER TABLE "AccountBalanceCredential"
ADD CONSTRAINT "AccountBalanceCredential_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "Sub2ApiAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
