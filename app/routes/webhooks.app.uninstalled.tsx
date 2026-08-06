import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { logger } from "../monitoring.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, session, topic } = await authenticate.webhook(request);
  logger.info("Webhook received", { shop, topic });

  // The app may be reinstalled later, so drop the session (it is dead) and the
  // cached catalogue (it will be stale), but keep the merchant's cost data:
  // re-entering every landed cost after an accidental uninstall would be
  // punishing, and it is their data, not ours.
  if (session) {
    await prisma.session.deleteMany({ where: { shop } });
    await prisma.variantSnapshot.deleteMany({ where: { shop } });
  }

  return new Response();
}
