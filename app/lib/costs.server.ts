import { randomUUID } from "crypto";

import prisma from "../db.server";
import {
  type ComponentConfidence,
  type ComponentKind,
  type CostComponentInput,
} from "./components";
import { toNumber } from "./settings.server";

/**
 * Persistence for a variant's cost blocks (`CostComponent`).
 *
 * Shopify's `InventoryItem.unitCost` stays the source of truth for the
 * supplier price; these rows are everything Shopify has nowhere to put —
 * freight, duty, packaging, a collapsed "£1 for the rest of it".
 */

/** Strips the `gid://shopify/ProductVariant/` prefix, leaving the numeric id. */
export function toNumericId(gid: string): string {
  const trimmed = gid.trim();
  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}

const VARIANT_KINDS: ComponentKind[] = [
  "FIXED_PER_UNIT",
  "PERCENT_OF_COST",
  "GROUP",
];
const CONFIDENCES: ComponentConfidence[] = ["KNOWN", "ESTIMATED", "GUESSED"];

/** Hard cap per variant: a cost model with more blocks than this is a bug. */
const MAX_COMPONENTS = 50;

/**
 * Coerces an untrusted component list (a request body) into a safe one.
 *
 * Everything is whitelisted or clamped rather than trusted: kind and
 * confidence against their unions, values to finite numbers, labels to a sane
 * length, and the list to a hard cap. Percentages are additionally clamped to
 * ±1000 points — a fat-fingered 45000% duty should not survive to the engine.
 */
export function sanitiseComponents(raw: unknown): CostComponentInput[] {
  if (!Array.isArray(raw)) return [];

  const out: CostComponentInput[] = [];
  for (const entry of raw.slice(0, MAX_COMPONENTS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Record<string, unknown>;

    const kind = candidate.kind as ComponentKind;
    if (!VARIANT_KINDS.includes(kind)) continue;

    const value = Number(candidate.value);
    if (!Number.isFinite(value)) continue;

    const confidence = CONFIDENCES.includes(
      candidate.confidence as ComponentConfidence,
    )
      ? (candidate.confidence as ComponentConfidence)
      : "ESTIMATED";

    out.push({
      id: String(candidate.id ?? randomUUID()).slice(0, 64),
      parentId:
        typeof candidate.parentId === "string" && candidate.parentId
          ? candidate.parentId.slice(0, 64)
          : null,
      label: String(candidate.label ?? "").trim().slice(0, 80) || "Cost",
      kind,
      value:
        kind === "PERCENT_OF_COST"
          ? Math.max(-1000, Math.min(1000, value))
          : Math.max(0, value),
      confidence,
      enabled: candidate.enabled !== false,
      sortOrder: out.length,
    });
  }
  return out;
}

function rowToInput(row: {
  id: string;
  parentId: string | null;
  label: string;
  kind: string;
  value: unknown;
  confidence: string;
  enabled: boolean;
  sortOrder: number;
}): CostComponentInput {
  return {
    id: row.id,
    parentId: row.parentId,
    label: row.label,
    // The DB enum is wider than the variant-level union (it is shared with
    // CostRule); saveComponents only ever writes variant kinds, so narrowing
    // here is safe, and an alien kind degrades to a harmless fixed £0.
    kind: VARIANT_KINDS.includes(row.kind as ComponentKind)
      ? (row.kind as ComponentKind)
      : "FIXED_PER_UNIT",
    value: VARIANT_KINDS.includes(row.kind as ComponentKind)
      ? toNumber(row.value as never)
      : 0,
    confidence: CONFIDENCES.includes(row.confidence as ComponentConfidence)
      ? (row.confidence as ComponentConfidence)
      : "ESTIMATED",
    enabled: row.enabled,
    sortOrder: row.sortOrder,
  };
}

export async function getComponents(
  shop: string,
  variantId: string,
): Promise<CostComponentInput[]> {
  const rows = await prisma.costComponent.findMany({
    where: { shop, variantId: toNumericId(variantId) },
    orderBy: { sortOrder: "asc" },
  });
  return rows.map(rowToInput);
}

/** Bulk variant of {@link getComponents}, keyed by numeric variant id. */
export async function getComponentsMap(
  shop: string,
  variantIds: string[],
): Promise<Map<string, CostComponentInput[]>> {
  const ids = variantIds.map(toNumericId);
  const rows = await prisma.costComponent.findMany({
    where: { shop, variantId: { in: ids } },
    orderBy: { sortOrder: "asc" },
  });

  const map = new Map<string, CostComponentInput[]>();
  for (const row of rows) {
    if (!row.variantId) continue;
    const list = map.get(row.variantId) ?? [];
    list.push(rowToInput(row));
    map.set(row.variantId, list);
  }
  return map;
}

/**
 * Replaces a variant's blocks wholesale.
 *
 * Ids are regenerated server-side — client-supplied ids are only trusted as
 * *references* (parentId links within the submitted list), never as primary
 * keys, since the id column is global and a crafted body could otherwise
 * collide with another shop's rows. The delete-and-insert pair runs in one
 * transaction so a failed save cannot leave a variant half-priced.
 */
export async function saveComponents(
  shop: string,
  variantId: string,
  productId: string,
  components: CostComponentInput[],
) {
  const numericVariantId = toNumericId(variantId);
  const numericProductId = toNumericId(productId);

  const idMap = new Map(
    components.map((component) => [component.id, randomUUID()]),
  );

  await prisma.$transaction([
    prisma.costComponent.deleteMany({
      where: { shop, variantId: numericVariantId },
    }),
    prisma.costComponent.createMany({
      data: components.map((component, index) => ({
        id: idMap.get(component.id)!,
        shop,
        variantId: numericVariantId,
        productId: numericProductId,
        parentId: component.parentId
          ? (idMap.get(component.parentId) ?? null)
          : null,
        label: component.label,
        kind: component.kind,
        value: component.value,
        confidence: component.confidence ?? "ESTIMATED",
        enabled: component.enabled !== false,
        sortOrder: index,
      })),
    }),
  ]);
}
