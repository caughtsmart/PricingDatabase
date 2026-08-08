-- AlterEnum
-- Postgres 12+ allows ADD VALUE inside a transaction as long as the new value
-- is not used in the same transaction; this migration only adds them.
ALTER TYPE "CostRuleKind" ADD VALUE IF NOT EXISTS 'PERCENT_OF_COST';
ALTER TYPE "CostRuleKind" ADD VALUE IF NOT EXISTS 'FIXED_PER_ORDER';
ALTER TYPE "CostRuleKind" ADD VALUE IF NOT EXISTS 'RATE_TIMES_COST';
ALTER TYPE "CostRuleKind" ADD VALUE IF NOT EXISTS 'PER_DAY_HELD';

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "avgUnitsPerOrder" DECIMAL(8,2) NOT NULL DEFAULT 1;
