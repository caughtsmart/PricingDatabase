import { randomUUID } from "crypto";

import prisma from "../db.server";
import {
  normaliseScopes,
  type ComponentBase,
  type ComponentConfidence,
  type ComponentKind,
  type ComponentScope,
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
const BASES: ComponentBase[] = ["LANDED_COST", "NET_REVENUE", "GROSS_PRICE"];

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
      // Only a percent has a denominator; anything else stores the default
      // so a later kind change starts from goods cost, not stale junk.
      base:
        kind === "PERCENT_OF_COST" &&
        BASES.includes(candidate.base as ComponentBase)
          ? (candidate.base as ComponentBase)
          : "LANDED_COST",
      scope: candidate.scope === "PRODUCT" ? "PRODUCT" : "VARIANT",
      confidence,
      enabled: candidate.enabled !== false,
      sortOrder: out.length,
    });
  }
  // A parent link across the variant/product boundary cannot be stored
  // coherently; sever it rather than letting it dangle.
  return normaliseScopes(out);
}

export function rowToInput(row: {
  id: string;
  parentId: string | null;
  variantId: string | null;
  label: string;
  kind: string;
  base: string;
  value: unknown;
  confidence: string;
  enabled: boolean;
  sortOrder: number;
}): CostComponentInput {
  return {
    id: row.id,
    parentId: row.parentId,
    // Scope is not a column: a row with no variantId IS a product block.
    scope: row.variantId ? "VARIANT" : "PRODUCT",
    label: row.label,
    // The DB enum is wider than the variant-level union (it is shared with
    // CostRule); saveComponents only ever writes variant kinds, so narrowing
    // here is safe, and an alien kind degrades to a harmless fixed £0.
    kind: VARIANT_KINDS.includes(row.kind as ComponentKind)
      ? (row.kind as ComponentKind)
      : "FIXED_PER_UNIT",
    base: BASES.includes(row.base as ComponentBase)
      ? (row.base as ComponentBase)
      : "LANDED_COST",
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

/**
 * A variant's *effective* blocks: the product's shared blocks first, then
 * the variant's own. One merged list is what resolution, the band and the
 * widget all consume — scope is a storage detail they can see but need not
 * understand.
 */
export async function getComponents(
  shop: string,
  variantId: string,
  productId: string,
): Promise<CostComponentInput[]> {
  const numericVariantId = toNumericId(variantId);
  const numericProductId = toNumericId(productId);
  const rows = await prisma.costComponent.findMany({
    where: {
      shop,
      OR: [
        { variantId: numericVariantId },
        { productId: numericProductId, variantId: null, templateId: null },
      ],
    },
    orderBy: { sortOrder: "asc" },
  });
  return [
    ...rows.filter((row) => !row.variantId),
    ...rows.filter((row) => row.variantId),
  ].map(rowToInput);
}

/** Bulk variant of {@link getComponents}, keyed by numeric variant id. */
export async function getComponentsMap(
  shop: string,
  keys: Array<{ variantId: string; productId: string }>,
): Promise<Map<string, CostComponentInput[]>> {
  const variantIds = keys.map((key) => toNumericId(key.variantId));
  const productIds = Array.from(
    new Set(keys.map((key) => toNumericId(key.productId))),
  );
  const rows = await prisma.costComponent.findMany({
    where: {
      shop,
      OR: [
        { variantId: { in: variantIds } },
        { productId: { in: productIds }, variantId: null, templateId: null },
      ],
    },
    orderBy: { sortOrder: "asc" },
  });

  const byVariant = new Map<string, CostComponentInput[]>();
  const byProduct = new Map<string, CostComponentInput[]>();
  for (const row of rows) {
    if (row.variantId) {
      const list = byVariant.get(row.variantId) ?? [];
      list.push(rowToInput(row));
      byVariant.set(row.variantId, list);
    } else if (row.productId) {
      const list = byProduct.get(row.productId) ?? [];
      list.push(rowToInput(row));
      byProduct.set(row.productId, list);
    }
  }

  const map = new Map<string, CostComponentInput[]>();
  for (const key of keys) {
    const variantId = toNumericId(key.variantId);
    map.set(variantId, [
      ...(byProduct.get(toNumericId(key.productId)) ?? []),
      ...(byVariant.get(variantId) ?? []),
    ]);
  }
  return map;
}

/**
 * Replaces a variant's effective blocks wholesale.
 *
 * The submitted list is split by scope: VARIANT blocks are rewritten for
 * this variant, PRODUCT blocks for the whole product — so a save from any
 * variant's widget updates the shared blocks everywhere, which is exactly
 * what "every variant of this product" promises.
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

  const toRow = (component: CostComponentInput) => ({
    id: idMap.get(component.id)!,
    shop,
    variantId: component.scope === "PRODUCT" ? null : numericVariantId,
    productId: numericProductId,
    parentId: component.parentId
      ? (idMap.get(component.parentId) ?? null)
      : null,
    label: component.label,
    kind: component.kind,
    base: component.base ?? "LANDED_COST",
    value: component.value,
    confidence: component.confidence ?? "ESTIMATED",
    enabled: component.enabled !== false,
  });

  const productBlocks = components.filter(
    (component) => component.scope === "PRODUCT",
  );
  const variantBlocks = components.filter(
    (component) => component.scope !== "PRODUCT",
  );

  await prisma.$transaction([
    prisma.costComponent.deleteMany({
      where: {
        shop,
        OR: [
          { variantId: numericVariantId },
          { productId: numericProductId, variantId: null, templateId: null },
        ],
      },
    }),
    prisma.costComponent.createMany({
      data: [...productBlocks.map(toRow), ...variantBlocks.map(toRow)].map(
        (row, index) => ({ ...row, sortOrder: index }),
      ),
    }),
  ]);
}
