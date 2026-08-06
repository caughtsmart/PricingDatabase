import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, topic, payload } = await authenticate.webhook(request);
  // eslint-disable-next-line no-console
  console.log(`Received ${topic} webhook for ${shop}`);

  const productId = (payload as { id?: number })?.id;
  if (!productId) return new Response();

  // Drop the cached rows so the product stops appearing in rollups. The saved
  // cost components stay: deleting a product in Shopify should not silently
  // destroy the merchant's cost history if they restore or recreate it.
  await prisma.variantSnapshot.deleteMany({
    where: { shop, productId: String(productId) },
  });

  return new Response();
}
