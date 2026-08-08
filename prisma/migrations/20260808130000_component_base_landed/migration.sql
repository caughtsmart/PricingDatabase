-- Honour CostComponent.base (MARGIN-MODEL.md §2.3 base overrides).
--
-- Until now every percent block was resolved against the goods cost and the
-- base column sat unread at its NET_REVENUE default. Now that the base is
-- honoured, that stored default would silently switch every existing duty
-- and FX block to a revenue denominator — so existing rows are set to
-- LANDED_COST, which is what they have always meant, and the column default
-- follows suit for rows created outside the app's save path.
ALTER TABLE "CostComponent" ALTER COLUMN "base" SET DEFAULT 'LANDED_COST';

UPDATE "CostComponent" SET "base" = 'LANDED_COST';
