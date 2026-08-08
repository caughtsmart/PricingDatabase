import prisma from "../db.server";

/**
 * Handling for Shopify's mandatory privacy webhooks.
 *
 * ## What personal data this app stores
 *
 * **None belonging to customers.** This is worth stating precisely, because it
 * determines the correct response to two of the three topics:
 *
 * - Product, variant, price and cost records hold no personal data.
 * - The sales figures behind realised margin come from a query that selects
 *   only `lineItems { quantity, variant { id } }`. No customer, address,
 *   email or name field is requested, and none is stored — `VariantSnapshot`
 *   keeps a single integer per variant.
 * - `Session` holds a shop domain, an access token, and for online sessions
 *   the *merchant staff* member's name and email. That is staff data, not
 *   customer data, and it is cleared by `shop/redact`.
 *
 * So `customers/data_request` has nothing to disclose and `customers/redact`
 * has nothing to erase. Both are still recorded, because "we hold nothing" is
 * a claim that has to be evidenced, and Shopify requires a 200 response either
 * way.
 *
 * `shop/redact` is the one that does real work: it arrives 48 hours after
 * uninstall and must remove everything belonging to that shop.
 */

/** Records that a compliance request arrived, before acting on it. */
export async function recordComplianceRequest(input: {
  shop: string;
  topic: string;
  customerId?: string | null;
  orderIds?: string | null;
}) {
  return prisma.complianceRequest.create({
    data: {
      shop: input.shop,
      topic: input.topic,
      customerId: input.customerId ?? null,
      orderIds: input.orderIds ?? null,
    },
  });
}

export async function completeComplianceRequest(id: string, resolution: string) {
  return prisma.complianceRequest.update({
    where: { id },
    data: { completedAt: new Date(), resolution },
  });
}

export interface PurgeResult {
  sessions: number;
  costComponents: number;
  costTemplates: number;
  variantSnapshots: number;
  costRules: number;
  syncRuns: number;
  shopSettings: number;
  total: number;
}

/**
 * Erases everything the app holds for a shop.
 *
 * Used by `shop/redact`. This is intentionally more aggressive than the
 * `app/uninstalled` handler: uninstalling keeps the merchant's hard-won cost
 * data in case they reinstall, but a redaction request is a legal instruction
 * to delete, so the cost data goes too.
 *
 * `ComplianceRequest` rows are kept — they are the audit trail proving this
 * ran, and they contain no personal data.
 */
export async function purgeShopData(shop: string): Promise<PurgeResult> {
  // CostRule has a foreign key onto ShopSettings, so it must go first. The
  // whole thing runs in one transaction: a partial purge would leave the shop
  // in a state no later webhook would come back to fix.
  const [
    costComponents,
    costTemplates,
    variantSnapshots,
    syncRuns,
    costRules,
    shopSettings,
    sessions,
  ] = await prisma.$transaction([
    prisma.costComponent.deleteMany({ where: { shop } }),
    prisma.costTemplate.deleteMany({ where: { shop } }),
    prisma.variantSnapshot.deleteMany({ where: { shop } }),
    prisma.syncRun.deleteMany({ where: { shop } }),
    prisma.costRule.deleteMany({ where: { shop } }),
    prisma.shopSettings.deleteMany({ where: { shop } }),
    prisma.session.deleteMany({ where: { shop } }),
  ]);

  const result: PurgeResult = {
    costComponents: costComponents.count,
    costTemplates: costTemplates.count,
    variantSnapshots: variantSnapshots.count,
    syncRuns: syncRuns.count,
    costRules: costRules.count,
    shopSettings: shopSettings.count,
    sessions: sessions.count,
    total: 0,
  };

  result.total =
    result.costComponents +
    result.costTemplates +
    result.variantSnapshots +
    result.syncRuns +
    result.costRules +
    result.shopSettings +
    result.sessions;

  return result;
}
