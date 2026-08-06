import prisma from "../db.server";
import type { VariantCostInputs } from "./margin";
import { toNumber } from "./settings.server";

/** Strips the `gid://shopify/ProductVariant/` prefix, leaving the numeric id. */
export function toNumericId(gid: string): string {
  const trimmed = gid.trim();
  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}

export interface VariantExtras {
  freight: number;
  duty: number;
  packaging: number;
  handling: number;
  other: number;
  notes: string | null;
}

export const EMPTY_EXTRAS: VariantExtras = {
  freight: 0,
  duty: 0,
  packaging: 0,
  handling: 0,
  other: 0,
  notes: null,
};

export async function getVariantExtras(
  shop: string,
  variantId: string,
): Promise<VariantExtras> {
  const record = await prisma.variantCost.findUnique({
    where: { shop_variantId: { shop, variantId: toNumericId(variantId) } },
  });

  if (!record) return { ...EMPTY_EXTRAS };

  return {
    freight: toNumber(record.freight),
    duty: toNumber(record.duty),
    packaging: toNumber(record.packaging),
    handling: toNumber(record.handling),
    other: toNumber(record.other),
    notes: record.notes,
  };
}

/** Bulk variant of {@link getVariantExtras}, keyed by numeric variant id. */
export async function getVariantExtrasMap(
  shop: string,
  variantIds: string[],
): Promise<Map<string, VariantExtras>> {
  const ids = variantIds.map(toNumericId);
  const records = await prisma.variantCost.findMany({
    where: { shop, variantId: { in: ids } },
  });

  const map = new Map<string, VariantExtras>();
  for (const record of records) {
    map.set(record.variantId, {
      freight: toNumber(record.freight),
      duty: toNumber(record.duty),
      packaging: toNumber(record.packaging),
      handling: toNumber(record.handling),
      other: toNumber(record.other),
      notes: record.notes,
    });
  }
  return map;
}

export async function saveVariantExtras(
  shop: string,
  variantId: string,
  productId: string,
  extras: Partial<VariantExtras>,
) {
  const id = toNumericId(variantId);
  const data = {
    freight: extras.freight ?? 0,
    duty: extras.duty ?? 0,
    packaging: extras.packaging ?? 0,
    handling: extras.handling ?? 0,
    other: extras.other ?? 0,
    notes: extras.notes ?? null,
  };

  return prisma.variantCost.upsert({
    where: { shop_variantId: { shop, variantId: id } },
    create: { shop, variantId: id, productId: toNumericId(productId), ...data },
    update: data,
  });
}

/** Merges Shopify's unit cost with the app's extras into engine input. */
export function toCostInputs(
  unitCost: number | null,
  extras: VariantExtras,
): VariantCostInputs {
  return {
    unitCost,
    freight: extras.freight,
    duty: extras.duty,
    packaging: extras.packaging,
    handling: extras.handling,
    other: extras.other,
  };
}
