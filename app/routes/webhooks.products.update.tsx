import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { logger } from "../monitoring.server";

interface ProductWebhookPayload {
  id: number;
  title?: string;
  vendor?: string;
  product_type?: string;
  status?: string;
  image?: { src?: string } | null;
  variants?: Array<{
    id: number;
    title?: string | null;
    sku?: string | null;
    price?: string | null;
    compare_at_price?: string | null;
    inventory_quantity?: number | null;
  }>;
}

function parseMoney(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Keeps the cached catalogue in step with edits made anywhere in the admin.
 *
 * Only the fields the webhook actually carries are touched. Notably the payload
 * has no unit cost, so `unitCost` is deliberately left as-is rather than being
 * nulled — otherwise a routine title change would wipe the cost out of the
 * dashboard until the next full sync.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { shop, topic, payload } = await authenticate.webhook(request);
  logger.info("Webhook received", { shop, topic });

  const product = payload as unknown as ProductWebhookPayload;
  if (!product?.id || !product.variants?.length) return new Response();

  const productId = String(product.id);

  await Promise.all(
    product.variants.map((variant) => {
      const price = parseMoney(variant.price);
      return prisma.variantSnapshot.updateMany({
        where: { shop, variantId: String(variant.id) },
        data: {
          productTitle: product.title ?? undefined,
          variantTitle: variant.title ?? null,
          sku: variant.sku ?? null,
          vendor: product.vendor ?? null,
          productType: product.product_type ?? null,
          status: product.status ?? null,
          imageUrl: product.image?.src ?? null,
          ...(price === null ? {} : { price }),
          compareAtPrice: parseMoney(variant.compare_at_price),
          inventoryQuantity: variant.inventory_quantity ?? 0,
          productId,
        },
      });
    }),
  );

  return new Response();
}
