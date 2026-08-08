import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
  getComponents,
  getComponentsMap,
  sanitiseComponents,
  saveComponents,
  toNumericId,
} from "../lib/costs.server";
import {
  componentsToCostInputs,
  type CostComponentInput,
} from "../lib/components";
import prisma from "../db.server";
import {
  fetchProductMarginData,
  updateUnitCost,
  updateVariantPrice,
  type GraphQLClient,
} from "../lib/catalog.server";
import {
  calculateMargin,
  daysHeldEstimate,
  quoteForTargetMargin,
  type MarginResult,
} from "../lib/margin";
import {
  confidenceBand,
  tightenSuggestions,
  type ConfidenceBand,
  type TightenSuggestion,
} from "../lib/confidence";
import {
  hiddenCostSummary,
  NUDGE_BLOCKS,
  viewForLevel,
  type DisclosureView,
} from "../lib/disclosure";
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
  /** The variant's cost blocks, in order; the widget edits these. */
  components: CostComponentInput[];
  margin: MarginResult;
  /** Pre-built money waterfall segments; the widget renders, never computes. */
  waterfall: Waterfall;
  /** Chip text when costs are folded away at this level; null when none are. */
  hiddenCostSummary: string | null;
  /** Margin range implied by estimated/guessed blocks; null when all certain. */
  band: ConfidenceBand | null;
  /** Blocks whose uncertainty costs the most margin certainty, worst first. */
  tighten: TightenSuggestion[];
}

export interface MarginApiPayload {
  productId: string;
  productTitle: string;
  currencyCode: string;
  targetMarginPct: number;
  /**
   * Progressive disclosure, resolved server-side so the widget renders flags
   * rather than re-implementing the level rules (which live, tested, in
   * disclosure.ts). Levels hide working, never money.
   */
  disclosure: {
    level: number;
    view: DisclosureView;
    /** The level-1 "most sellers forget" one-tap draft blocks. */
    nudgeBlocks: Array<{
      label: string;
      kind: "FIXED_PER_UNIT" | "PERCENT_OF_COST";
    }>;
  };
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
  const [componentsMap, snapshots] = await Promise.all([
    getComponentsMap(session.shop, variantIds),
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
    disclosure: {
      level: config.disclosureLevel,
      view: viewForLevel(config.disclosureLevel),
      nudgeBlocks: NUDGE_BLOCKS,
    },
    appliedRuleNames: config.rules
      .filter((rule) => rule.enabled)
      .map((rule) => rule.name),
    variants: product.variants.map((variant) => {
      const numericId = toNumericId(variant.id);
      const components = componentsMap.get(numericId) ?? [];
      const context = {
        unitsPerOrder: config.avgUnitsPerOrder,
        // No snapshot yet (never synced) → 0 days: holding rules stay
        // silent rather than guessing.
        daysHeld: unitsSoldByVariant.has(numericId)
          ? daysHeldEstimate(
              variant.inventoryQuantity,
              unitsSoldByVariant.get(numericId) ?? 0,
            )
          : 0,
      };
      const margin = calculateMargin({
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        costs: componentsToCostInputs(variant.unitCost, components),
        rules: config.rules,
        settings: config.settings,
        context,
      });
      // The confidence band and tighten list run the same engine at the
      // uncertain blocks' bounds — computed here so the widget renders a
      // range it never has to derive.
      const bandInput = {
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        unitCost: variant.unitCost,
        components,
        rules: config.rules,
        settings: config.settings,
        context,
      };
      return {
        variantId: variant.id,
        inventoryItemId: variant.inventoryItemId,
        title: variant.title,
        sku: variant.sku,
        price: variant.price,
        inventoryQuantity: variant.inventoryQuantity,
        components,
        margin,
        waterfall: buildWaterfall(margin),
        hiddenCostSummary: hiddenCostSummary(
          config.disclosureLevel,
          components.filter((component) => component.enabled !== false).length,
          margin.appliedCosts.length,
        ),
        band: confidenceBand(bandInput),
        tighten: tightenSuggestions(bandInput),
      };
    }),
  };

  return cors(jsonResponse(payload));
}

interface SavePayload {
  /**
   * "save" persists costs (the default, and the pre-intent behaviour);
   * "solve" quotes the price for a target margin from the draft costs as
   * typed, persisting nothing — what-if must be free to play with;
   * "apply-price" writes a confirmed solved price back to the variant.
   */
  intent?: "save" | "solve" | "apply-price";
  variantId?: string;
  productId?: string;
  inventoryItemId?: string | null;
  unitCost?: number | null;
  /** The variant's current selling price, so the response can echo a fresh margin. */
  price?: number;
  compareAtPrice?: number | null;
  /** The variant's cost blocks; sanitised server-side, never trusted. */
  components?: unknown;
  /** For "solve": the net margin to hit, in percentage points. */
  targetMarginPct?: number;
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

  const components = sanitiseComponents(body.components);

  const intent = body.intent ?? "save";

  if (intent === "solve") {
    const target = Number(body.targetMarginPct);
    if (!Number.isFinite(target) || target >= 100) {
      return cors(
        jsonResponse({ error: "targetMarginPct must be a number below 100" }, 400),
      );
    }

    const [config, snapshot] = await Promise.all([
      getShopConfig(session.shop),
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

    const quote = quoteForTargetMargin(
      // The draft blocks exactly as typed — solving persists nothing, so the
      // merchant can play what-if without committing anything.
      componentsToCostInputs(
        typeof body.unitCost === "number" && Number.isFinite(body.unitCost)
          ? body.unitCost
          : null,
        components,
      ),
      config.rules,
      config.settings,
      target,
      {
        unitsPerOrder: config.avgUnitsPerOrder,
        daysHeld: snapshot
          ? daysHeldEstimate(snapshot.inventoryQuantity, snapshot.unitsSold)
          : 0,
      },
    );

    if (!quote) {
      const revenuePct = config.rules
        .filter((rule) => rule.enabled && rule.kind === "PERCENT_OF_REVENUE")
        .reduce((total, rule) => total + rule.value, 0);
      return cors(
        jsonResponse({
          solvable: false,
          reason: `No price can reach ${target}%: your percentage-of-revenue costs already take ${revenuePct}% of every sale, and together they add up to the whole price or more.`,
        }),
      );
    }

    return cors(
      jsonResponse({
        solvable: true,
        price: quote.price,
        margin: quote.result,
        waterfall: buildWaterfall(quote.result),
      }),
    );
  }

  if (intent === "apply-price") {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0) {
      return cors(
        jsonResponse({ error: "A positive price is required" }, 400),
      );
    }

    const userErrors = await updateVariantPrice(
      admin.graphql as GraphQLClient,
      body.productId,
      body.variantId,
      price,
    );

    return cors(jsonResponse({ ok: userErrors.length === 0, userErrors }));
  }

  await saveComponents(session.shop, body.variantId, body.productId, components);

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
  const [savedComponents, snapshot] = await Promise.all([
    getComponents(session.shop, body.variantId),
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
    costs: componentsToCostInputs(
      typeof body.unitCost === "number" ? body.unitCost : null,
      savedComponents,
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
      components: savedComponents,
      margin,
      waterfall: buildWaterfall(margin),
    }),
  );
}
