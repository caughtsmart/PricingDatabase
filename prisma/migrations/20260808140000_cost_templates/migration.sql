-- Named cost templates: a reusable set of blocks ("Imported from EU")
-- typed once and applied to any product. Template blocks are CostComponent
-- rows with templateId set and variantId/productId null — the nullability
-- the schema reserved for exactly this.
ALTER TABLE "CostComponent" ADD COLUMN "templateId" TEXT;

CREATE INDEX "CostComponent_shop_templateId_idx" ON "CostComponent"("shop", "templateId");

CREATE TABLE "CostTemplate" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CostTemplate_shop_idx" ON "CostTemplate"("shop");

CREATE UNIQUE INDEX "CostTemplate_shop_name_key" ON "CostTemplate"("shop", "name");
