import type { ActionFunctionArgs } from "react-router";

import {
  completeComplianceRequest,
  purgeShopData,
  recordComplianceRequest,
} from "../lib/gdpr.server";
import { authenticate } from "../shopify.server";
import { logger } from "../monitoring.server";

/**
 * Mandatory topic: erase everything belonging to a shop.
 *
 * Arrives 48 hours after the app is uninstalled, by which point the session has
 * already been deleted by the `app/uninstalled` handler — so nothing here may
 * depend on a session existing.
 *
 * This is the topic that does real work. `app/uninstalled` deliberately keeps
 * the merchant's cost data in case they reinstall; a redaction request revokes
 * that grace and everything goes.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { shop, topic } = await authenticate.webhook(request);

  const record = await recordComplianceRequest({ shop, topic });

  try {
    const purged = await purgeShopData(shop);
    await completeComplianceRequest(
      record.id,
      `Purged ${purged.total} rows: ${purged.costComponents} cost blocks, ` +
        `${purged.variantSnapshots} snapshots, ${purged.costRules} cost rules, ` +
        `${purged.syncRuns} sync runs, ${purged.shopSettings} settings, ` +
        `${purged.sessions} sessions.`,
    );

    logger.info("Compliance purge complete", {
      shop,
      topic,
      rowsPurged: purged.total,
    });
  } catch (error) {
    // Leave the request row open (no completedAt) so an incomplete purge is
    // visible rather than silently recorded as done. Shopify retries on a
    // non-2xx, so rethrowing gives us another attempt inside the 30-day window.
    logger.error("Compliance purge failed", { shop, topic, error });
    throw error;
  }

  return new Response();
}
