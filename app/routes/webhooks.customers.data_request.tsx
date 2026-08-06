import type { ActionFunctionArgs } from "react-router";

import {
  completeComplianceRequest,
  recordComplianceRequest,
} from "../lib/gdpr.server";
import { authenticate } from "../shopify.server";

interface DataRequestPayload {
  shop_domain?: string;
  customer?: { id?: number; email?: string; phone?: string };
  orders_requested?: number[];
  data_request?: { id?: number };
}

/**
 * Mandatory topic: a customer has asked the store owner for their data.
 *
 * This app stores no customer data (see `gdpr.server.ts` for the inventory), so
 * there is nothing to hand back. The request is still logged so the "we hold
 * nothing" answer is evidenced rather than merely asserted.
 *
 * Note the payload itself contains the customer's email and phone. Those are
 * deliberately not written to the audit row — recording personal data in order
 * to prove we do not record personal data would be self-defeating.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const body = payload as unknown as DataRequestPayload;

  const record = await recordComplianceRequest({
    shop,
    topic,
    customerId: body.customer?.id ? String(body.customer.id) : null,
    orderIds: body.orders_requested?.length
      ? body.orders_requested.join(",")
      : null,
  });

  await completeComplianceRequest(
    record.id,
    "No customer personal data is stored by this app; nothing to disclose.",
  );

  // eslint-disable-next-line no-console
  console.log(
    `[compliance] ${topic} for ${shop} (request ${body.data_request?.id ?? "unknown"}): no customer data held`,
  );

  return new Response();
}
