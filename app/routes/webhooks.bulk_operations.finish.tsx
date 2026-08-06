import type { ActionFunctionArgs } from "react-router";

import { enqueueSync } from "../queue.server";
import { findRunByBulkOperation } from "../lib/sync.server";
import { authenticate } from "../shopify.server";
import { logger } from "../monitoring.server";

interface BulkFinishPayload {
  admin_graphql_api_id?: string;
  status?: string;
  error_code?: string | null;
  type?: string;
}

/**
 * Shopify has finished a bulk operation.
 *
 * The handler does as little as possible: match the operation back to its sync
 * run and queue the ingest. Downloading and importing a JSONL file can take
 * minutes, and a webhook that does not return promptly gets retried — which
 * would mean several ingests racing each other.
 *
 * This topic fires for *every* bulk operation the app runs, so an operation
 * that does not belong to a tracked run is acknowledged and ignored.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const body = payload as unknown as BulkFinishPayload;

  const bulkOperationId = body.admin_graphql_api_id;
  if (!bulkOperationId) return new Response();

  const run = await findRunByBulkOperation(shop, bulkOperationId);
  if (!run) {
    logger.info("Bulk operation has no tracked sync run; ignoring", {
      shop,
      topic,
      bulkOperationId,
    });
    return new Response();
  }

  await enqueueSync({ shop, syncRunId: run.id });

  logger.info("Queued bulk ingest", {
    shop,
    topic,
    syncRunId: run.id,
    stage: run.stage,
    bulkStatus: body.status,
  });

  return new Response();
}
