import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { logger } from "../monitoring.server";

export async function action({ request }: ActionFunctionArgs) {
  const { payload, session, topic, shop } = await authenticate.webhook(request);
  logger.info("Webhook received", { shop, topic });

  const current = payload.current as string[];
  if (session) {
    await prisma.session.update({
      where: { id: session.id },
      data: { scope: current.toString() },
    });
  }

  return new Response();
}
