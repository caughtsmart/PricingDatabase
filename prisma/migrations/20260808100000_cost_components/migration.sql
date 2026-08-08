-- AlterEnum: GROUP is CostComponent-only; CostRule rows never carry it
-- (enforced in application code — the enum is shared).
ALTER TYPE "CostRuleKind" ADD VALUE IF NOT EXISTS 'GROUP';

-- CreateEnum
CREATE TYPE "CostBase" AS ENUM ('NET_REVENUE', 'GROSS_PRICE', 'LANDED_COST');

-- CreateEnum
CREATE TYPE "Confidence" AS ENUM ('KNOWN', 'ESTIMATED', 'GUESSED');

-- CreateTable
CREATE TABLE "CostComponent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "variantId" TEXT,
    "productId" TEXT,
    "parentId" TEXT,
    "label" TEXT NOT NULL,
    "kind" "CostRuleKind" NOT NULL,
    "base" "CostBase" NOT NULL DEFAULT 'NET_REVENUE',
    "value" DECIMAL(12,4) NOT NULL,
    "confidence" "Confidence" NOT NULL DEFAULT 'ESTIMATED',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostComponent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CostComponent_shop_variantId_idx" ON "CostComponent"("shop", "variantId");

-- CreateIndex
CREATE INDEX "CostComponent_shop_productId_idx" ON "CostComponent"("shop", "productId");

-- DataMigration: the five fixed columns become one row each, zero values
-- skipped (a £0 component is noise, and the sum is unchanged). Migrated rows
-- are marked KNOWN, not the ESTIMATED default: the merchant typed these
-- figures deliberately, and a behaviour-preserving upgrade must not turn
-- their settled margins into provisional ones.
INSERT INTO "CostComponent"
  ("id", "shop", "variantId", "productId", "label", "kind", "base", "value",
   "confidence", "enabled", "sortOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, "shop", "variantId", "productId", cols.label,
       'FIXED_PER_UNIT'::"CostRuleKind", 'NET_REVENUE'::"CostBase", cols.value,
       'KNOWN'::"Confidence", true, cols.ord, "createdAt", CURRENT_TIMESTAMP
FROM "VariantCost",
LATERAL (VALUES
  ('Freight',   "freight",   0),
  ('Duty',      "duty",      1),
  ('Packaging', "packaging", 2),
  ('Handling',  "handling",  3),
  ('Other',     "other",     4)
) AS cols(label, value, ord)
WHERE cols.value <> 0;

-- DropTable: the copy above is the replacement; nothing reads this any more.
DROP TABLE "VariantCost";
