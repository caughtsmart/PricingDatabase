-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CostRuleKind" AS ENUM ('PERCENT_OF_REVENUE', 'FIXED_PER_UNIT');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "shop" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'GBP',
    "pricesIncludeTax" BOOLEAN NOT NULL DEFAULT true,
    "taxRatePct" DECIMAL(6,3) NOT NULL DEFAULT 20,
    "targetMarginPct" DECIMAL(6,3) NOT NULL DEFAULT 35,
    "warnMarginPct" DECIMAL(6,3) NOT NULL DEFAULT 20,
    "criticalMarginPct" DECIMAL(6,3) NOT NULL DEFAULT 10,
    "defaultsSeeded" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "CostRule" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "CostRuleKind" NOT NULL,
    "value" DECIMAL(12,4) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantCost" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "freight" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "duty" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "packaging" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "handling" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "other" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariantCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantSnapshot" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT,
    "sku" TEXT,
    "vendor" TEXT,
    "productType" TEXT,
    "status" TEXT,
    "imageUrl" TEXT,
    "price" DECIMAL(12,4) NOT NULL,
    "compareAtPrice" DECIMAL(12,4),
    "unitCost" DECIMAL(12,4),
    "inventoryQuantity" INTEGER NOT NULL DEFAULT 0,
    "unitsSold" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VariantSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "variantsSynced" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE INDEX "CostRule_shop_enabled_idx" ON "CostRule"("shop", "enabled");

-- CreateIndex
CREATE INDEX "VariantCost_shop_productId_idx" ON "VariantCost"("shop", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "VariantCost_shop_variantId_key" ON "VariantCost"("shop", "variantId");

-- CreateIndex
CREATE INDEX "VariantSnapshot_shop_productId_idx" ON "VariantSnapshot"("shop", "productId");

-- CreateIndex
CREATE INDEX "VariantSnapshot_shop_vendor_idx" ON "VariantSnapshot"("shop", "vendor");

-- CreateIndex
CREATE UNIQUE INDEX "VariantSnapshot_shop_variantId_key" ON "VariantSnapshot"("shop", "variantId");

-- CreateIndex
CREATE INDEX "SyncRun_shop_startedAt_idx" ON "SyncRun"("shop", "startedAt");

-- AddForeignKey
ALTER TABLE "CostRule" ADD CONSTRAINT "CostRule_shop_fkey" FOREIGN KEY ("shop") REFERENCES "ShopSettings"("shop") ON DELETE CASCADE ON UPDATE CASCADE;

