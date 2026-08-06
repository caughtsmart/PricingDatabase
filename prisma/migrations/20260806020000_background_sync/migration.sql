-- AlterTable
ALTER TABLE "VariantSnapshot" ADD COLUMN     "lastSeenSyncId" TEXT;

-- AlterTable
ALTER TABLE "SyncRun" ADD COLUMN     "bulkOperationId" TEXT,
ADD COLUMN     "objectCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ordersScanned" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stage" TEXT NOT NULL DEFAULT 'catalog';

-- AlterTable
ALTER TABLE "SyncRun" ALTER COLUMN "status" SET DEFAULT 'queued';

-- CreateIndex
CREATE INDEX "VariantSnapshot_shop_lastSeenSyncId_idx" ON "VariantSnapshot"("shop", "lastSeenSyncId");

-- CreateIndex
CREATE INDEX "SyncRun_bulkOperationId_idx" ON "SyncRun"("bulkOperationId");
