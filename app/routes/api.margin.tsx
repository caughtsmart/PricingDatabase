import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
  getVariantExtras,
  getVariantExtrasMap,
  saveVariantExtras,
  toCostInputs,
  toNumericId,
  EMPTY_EXTRAS,
  type VariantExtras,
} from "../lib/costs.server";
import prisma from "../db.server";
import {
  fetchProductMarginData,
  updateUnitCost,
  type GraphQLClient,
} from "../lib/catalog.server";
import {
  calculateMargin,
  daysHeldEstimate,
  type MarginResult,
} from "../lib/margin";
import { buildWaterfall, type Waterfall } from "../lib/waterfall";
import { getShopConfig } from "../lib/settings.server";
import { authenticate } from "../shopify.server";

/**
 * The data endpoint behind the product-page widget.
 *
 * Admin UI extensions call this with `fetch('/api/margin?...')`. Shopify
 * resolves that relative URL against the app's `application_url` and attaches
 * an OpenID Connect ID token automatically, which `authenticate.admin` then
 * verifies — so there is no bespoke token handling here. The `cors` helper is
 * required because the extension runs on a Shopify-hosted origin.
 *
 * The margin engine deliberately lives on this side of the wire. The widget and
 * the dashboard therefore cannot drift apart: there is exactly one
 * implementation of the arithmetic, and it is unit tested.
 */

export interface VariantMarginPayload {
  variantId: string;
  inventoryItemId: string | null;
  title: string | null;
  sku: string | null;
  price: number;
  inventoryQuantity: number;
  extras: VariantExtras;
  margin: MarginResult;
  /** Pre-built money waterfall segments; the widget renders, never computes. */
  waterfall: Waterfall;
}

export interface MarginApiPayload {
  productId: string;
  productTitle: string;
  currencyCode: string;
  targetMarginPct: number;
  variants: VariantMarginPayload[];
  appliedRuleNames: string[];
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session, cors } = await authenticate.admin(request);

  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");
  if (!productId) {
    return cors(jsonResponse({ error: "productId is required" }, 400));
  }

  const [product, config] = await Promise.all([
    fetchProductMarginData(admin.graphql as GraphQLClient, productId),
    getShopConfig(session.shop),
  ]);

  if (!product) {
    return cors(jsonResponse({ error: "Product not found" }, 404));
  }

  const variantIds = product.variants.map((variant) => variant.id);
  const [extrasMap, snapshots] = await Promise.all([
    getVariantExtrasMap(session.shop, variantIds),
    // The live product query carries no sales history; the synced snapshot
    // does. Holding-cost rules need it to estimate days in stock.
    prisma.variantSnapshot.findMany({
      where: { shop: session.shop, variantId: { in: variantIds.map(toNumericId) } },
      select: { variantId: true, unitsSold: true },
    }),
  ]);
  const unitsSoldByVariant = new Map(
    snapshots.map((snapshot) => [snapshot.variantId, snapshot.unitsSold]),
  );

  const payload: MarginApiPayload = {
    productId: product.productId,
    productTitle: product.productTitle,
    currencyCode: product.currencyCode || config.currencyCode,
    targetMarginPct: config.settings.targetMarginPct,
    appliedRuleNames: config.rules
      .filter((rule) => rule.enabled)
      .map((rule) => rule.name),
    variants: product.variants.map((variant) => {
      const numericId = toNumericId(variant.id);
      const extras = extrasMap.get(numericId) ?? { ...EMPTY_EXTRAS };
      const margin = calculateMargin({
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        costs: toCostInputs(variant.unitCost, extras),
        rules: config.rules,
        settings: config.settings,
        context: {
          unitsPerOrder: config.avgUnitsPerOrder,
          // No snapshot yet (never synced) → 0 days: holding rules stay
          // silent rather than guessing.
          daysHeld: unitsSoldByVariant.has(numericId)
            ? daysHeldEstimate(
                variant.inventoryQuantity,
                unitsSoldByVariant.get(numericId) ?? 0,
              )
            : 0,
        },
      });
      return {
        variantId: variant.id,
        inventoryItemId: variant.inventoryItemId,
        title: variant.title,
        sku: variant.sku,
        price: variant.price,
        inventoryQuantity: variant.inventoryQuantity,
        extras,
        margin,
        waterfall: buildWaterfall(margin),
      };
    }),
  };

  return cors(jsonResponse(payload));
}

interface SavePayload {
  variantId?: string;
  productId?: string;
  inventoryItemId?: string | null;
  unitCost?: number | null;
  /** The variant's current selling price, so the response can echo a fresh margin. */
  price?: number;
  compareAtPrice?: number | null;
  extras?: Partial<VariantExtras>;
}

function sanitiseAmount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session, cors } = await authenticate.admin(request);

  if (request.method !== "POST") {
    return cors(jsonResponse({ error: "Method not allowed" }, 405));
  }

  let body: SavePayload;
  try {
    body = (await request.json()) as SavePayload;
  } catch {
    return cors(jsonResponse({ error: "Invalid JSON body" }, 400));
  }

  if (!body.variantId || !body.productId) {
    return cors(
      jsonResponse({ error: "variantId and productId are required" }, 400),
    );
  }

  const extras: VariantExtras = {
    freight: sanitiseAmount(body.extras?.freight),
    duty: sanitiseAmount(body.extras?.duty),
    packaging: sanitiseAmount(body.extras?.packaging),
    handling: sanitiseAmount(body.extras?.handling),
    other: sanitiseAmount(body.extras?.other),
    notes: body.extras?.notes ? String(body.extras.notes).slice(0, 500) : null,
  };

  await saveVariantExtras(
    session.shop,
    body.variantId,
    body.productId,
    extras,
  );

  // Writing the unit cost back to Shopify keeps its own "Cost per item" field
  // authoritative, so reports elsewhere in the admin agree with this app.
  const userErrors: string[] = [];
  if (
    body.inventoryItemId &&
    typeof body.unitCost === "number" &&
    Number.isFinite(body.unitCost) &&
    body.unitCost >= 0
  ) {
    const errors = await updateUnitCost(
      admin.graphql as GraphQLClient,
      body.inventoryItemId,
      body.unitCost,
    );
    userErrors.push(...errors);
  }

  const config = await getShopConfig(session.shop);
  // Re-read rather than trusting the request body, so the response reflects
  // exactly what was persisted.
  const [savedExtras, snapshot] = await Promise.all([
    getVariantExtras(session.shop, body.variantId),
    prisma.variantSnapshot.findUnique({
      where: {
        shop_variantId: {
          shop: session.shop,
          variantId: toNumericId(body.variantId),
        },
      },
      select: { inventoryQuantity: true, unitsSold: true },
    }),
  ]);

  const margin = calculateMargin({
    price: sanitiseAmount(body.price),
    compareAtPrice: body.compareAtPrice ?? null,
    costs: toCostInputs(
      typeof body.unitCost === "number" ? body.unitCost : null,
      savedExtras,
    ),
    rules: config.rules,
    settings: config.settings,
    context: {
      unitsPerOrder: config.avgUnitsPerOrder,
      daysHeld: snapshot
        ? daysHeldEstimate(snapshot.inventoryQuantity, snapshot.unitsSold)
        : 0,
    },
  });

  return cors(
    jsonResponse({
      ok: userErrors.length === 0,
      userErrors,
      extras: savedExtras,
      margin,
      waterfall: buildWaterfall(margin),
    }),
  );
}
