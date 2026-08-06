-- CreateTable
CREATE TABLE "ComplianceRequest" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "customerId" TEXT,
    "orderIds" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "resolution" TEXT,

    CONSTRAINT "ComplianceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComplianceRequest_shop_topic_idx" ON "ComplianceRequest"("shop", "topic");
