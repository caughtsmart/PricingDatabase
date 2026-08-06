import prisma from "../db.server";
import { EMPTY_EXTRAS, getVariantExtrasMap, toCostInputs } from "./costs.server";
import {
  aggregate,
  calculateMargin,
  type AggregateTotals,
  type MarginResult,
} from "./margin";
import { describeDetection } from "./onboarding";
import { getShopConfig, toNullableNumber, toNumber } from "./settings.server";

export interface RollupLine {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string | null;
  sku: string | null;
  vendor: string | null;
  productType: string | null;
  status: string | null;
  imageUrl: string | null;
  price: number;
  inventoryQuantity: number;
  unitsSold: number;
  margin: MarginResult;
}

export interface Rollup {
  lines: RollupLine[];
  totals: AggregateTotals;
  currencyCode: string;
  lastSyncedAt: Date | null;
  targetMarginPct: number;
  onboardedAt: Date | null;
  needsRateConfirmation: boolean;
  /** Plain-English summary of the detected tax setup, for the onboarding banner. */
  detectionSummary: string;
}

/**
 * Builds every per-variant margin for a shop, plus the dashboard totals.
 *
 * Reads from the local `VariantSnapshot` cache rather than the Admin API, so a
 * dashboard load costs one database round trip instead of hundreds of
 * rate-limited GraphQL pages.
 */
export async function buildRollup(shop: string): Promise<Rollup> {
  const [config, snapshots] = await Promise.all([
    getShopConfig(shop),
    prisma.variantSnapshot.findMany({
      where: { shop },
      orderBy: { productTitle: "asc" },
    }),
  ]);

  const extrasMap = await getVariantExtrasMap(
    shop,
    snapshots.map((snapshot) => snapshot.variantId),
  );

  const lines: RollupLine[] = snapshots.map((snapshot) => {
    const extras = extrasMap.get(snapshot.variantId) ?? { ...EMPTY_EXTRAS };
    const price = toNumber(snapshot.price);

    return {
      variantId: snapshot.variantId,
      productId: snapshot.productId,
      productTitle: snapshot.productTitle,
      variantTitle: snapshot.variantTitle,
      sku: snapshot.sku,
      vendor: snapshot.vendor,
      productType: snapshot.productType,
      status: snapshot.status,
      imageUrl: snapshot.imageUrl,
      price,
      inventoryQuantity: snapshot.inventoryQuantity,
      unitsSold: snapshot.unitsSold,
      margin: calculateMargin({
        price,
        compareAtPrice: toNullableNumber(snapshot.compareAtPrice),
        costs: toCostInputs(toNullableNumber(snapshot.unitCost), extras),
        rules: config.rules,
        settings: config.settings,
      }),
    };
  });

  const totals = aggregate(
    lines.map((line) => ({
      result: line.margin,
      inventoryQuantity: line.inventoryQuantity,
      unitsSold: line.unitsSold,
    })),
  );

  return {
    lines,
    totals,
    currencyCode: config.currencyCode,
    lastSyncedAt: config.lastSyncedAt,
    targetMarginPct: config.settings.targetMarginPct,
    onboardedAt: config.onboardedAt,
    needsRateConfirmation: config.needsRateConfirmation,
    detectionSummary: describeDetection({
      pricesIncludeTax: config.settings.pricesIncludeTax,
      taxRatePct: config.settings.taxRatePct,
      currencyCode: config.currencyCode,
      countryCode: config.detectedCountryCode,
      needsRateConfirmation: config.needsRateConfirmation,
    }),
  };
}

export interface VendorBreakdown {
  vendor: string;
  variantCount: number;
  averageNetMarginPct: number;
  potentialProfit: number;
  realisedProfit: number;
}

/** Groups lines by vendor so the merchant can see which supplier earns its keep. */
export function breakdownByVendor(lines: RollupLine[]): VendorBreakdown[] {
  const groups = new Map<string, RollupLine[]>();

  for (const line of lines) {
    const vendor = line.vendor?.trim() || "No vendor";
    const existing = groups.get(vendor);
    if (existing) {
      existing.push(line);
    } else {
      groups.set(vendor, [line]);
    }
  }

  return Array.from(groups.entries())
    .map(([vendor, vendorLines]) => {
      const totals = aggregate(
        vendorLines.map((line) => ({
          result: line.margin,
          inventoryQuantity: line.inventoryQuantity,
          unitsSold: line.unitsSold,
        })),
      );
      return {
        vendor,
        variantCount: vendorLines.length,
        averageNetMarginPct: totals.averageNetMarginPct,
        potentialProfit: totals.potentialProfit,
        realisedProfit: totals.realisedProfit,
      };
    })
    .sort((a, b) => b.realisedProfit - a.realisedProfit);
}
