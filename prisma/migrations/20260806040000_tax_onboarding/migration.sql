-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "onboardedAt" TIMESTAMP(3),
ADD COLUMN     "detectedCountryCode" TEXT,
ADD COLUMN     "needsRateConfirmation" BOOLEAN NOT NULL DEFAULT false;
