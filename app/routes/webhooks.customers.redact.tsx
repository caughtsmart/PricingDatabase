import type { ActionFunctionArgs } from "react-router";

import {
  completeComplianceRequest,
  recordComplianceRequest,
} from "../lib/gdpr.server";
import { authenticate } from "../shopify.server";

interface RedactPayload {
  shop_domain?: string;
  customer?: { id?: number; email?: string; phone?: string };
  orders_to_redact?: number[];
}

/**
 * Mandatory topic: erase a specific customer's data.
 *
 * Nothing to erase — this app never stores customer records. The sales tally
 * behind realised margin is a per-variant integer with no link back to any
 * customer or order, so there is no row that redacting a customer would
 * change.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const body = payload as unknown as RedactPayload;

  const record = await recordComplianceRequest({
    shop,
    topic,
    customerId: body.customer?.id ? String(body.customer.id) : null,
    orderIds: body.orders_to_redact?.length
      ? body.orders_to_redact.join(",")
      : null,
  });

  await completeComplianceRequest(
    record.id,
    "No customer personal data is stored by this app; nothing to erase.",
  );

  // eslint-disable-next-line no-console
  console.log(`[compliance] ${topic} for ${shop}: no customer data held`);

  return new Response();
}
