-- Progressive disclosure level (MARGIN-MODEL.md §4).
--
-- New installs start at level 1 ("Am I losing money?") via the column
-- default. Existing shops are set to 3: they installed before levels
-- existed, so the full view is what they are used to — a merchant must
-- never open the app and find detail silently gone.
ALTER TABLE "ShopSettings" ADD COLUMN "disclosureLevel" INTEGER NOT NULL DEFAULT 1;

UPDATE "ShopSettings" SET "disclosureLevel" = 3;
