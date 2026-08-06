import type { Prisma } from "@prisma/client";

import prisma from "../db.server";
import type { CostRule, MarginSettings } from "./margin";

/**
 * Prisma returns money and percentage columns as `Decimal` objects. The margin
 * engine works in plain numbers, so every value is converted exactly once, here
 * at the boundary, rather than being sprinkled through the UI.
 */
export function toNumber(
  value: Prisma.Decimal | number | null | undefined,
): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  return value.toNumber();
}

export function toNullableNumber(
  value: Prisma.Decimal | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  return value.toNumber();
}

/**
 * Sensible starting rules for a new install.
 *
 * These are seeded once, then left alone: `defaultsSeeded` stops us from
 * re-creating a rule a merchant has deliberately deleted.
 */
const DEFAULT_COST_RULES: Array<
  Pick<CostRule, "name" | "kind" | "value"> & { sortOrder: number }
> = [
  {
    name: "Payment processing",
    kind: "PERCENT_OF_REVENUE",
    value: 1.75,
    sortOrder: 0,
  },
  {
    name: "Pick & pack",
    kind: "FIXED_PER_UNIT",
    value: 0,
    sortOrder: 1,
  },
];

export interface ShopConfig {
  settings: MarginSettings;
  rules: CostRule[];
  currencyCode: string;
  lastSyncedAt: Date | null;
  autoSyncEnabled: boolean;
  /** Null until the merchant has confirmed the detected tax setup. */
  onboardedAt: Date | null;
  detectedCountryCode: string | null;
  needsRateConfirmation: boolean;
}

/**
 * Loads a shop's config, creating it with defaults on first access.
 *
 * Every entry point (dashboard, widget API, webhooks) goes through this, so an
 * install that somehow skipped the OAuth callback still gets working defaults
 * rather than a crash.
 */
export async function getShopConfig(shop: string): Promise<ShopConfig> {
  let record = await prisma.shopSettings.findUnique({
    where: { shop },
    include: { costRules: { orderBy: { sortOrder: "asc" } } },
  });

  if (!record) {
    await prisma.shopSettings.upsert({
      where: { shop },
      create: { shop },
      update: {},
    });
    record = await prisma.shopSettings.findUniqueOrThrow({
      where: { shop },
      include: { costRules: { orderBy: { sortOrder: "asc" } } },
    });
  }

  if (!record.defaultsSeeded) {
    await prisma.$transaction([
      prisma.costRule.createMany({
        data: DEFAULT_COST_RULES.map((rule) => ({ ...rule, shop })),
      }),
      prisma.shopSettings.update({
        where: { shop },
        data: { defaultsSeeded: true },
      }),
    ]);
    record = await prisma.shopSettings.findUniqueOrThrow({
      where: { shop },
      include: { costRules: { orderBy: { sortOrder: "asc" } } },
    });
  }

  return {
    currencyCode: record.currencyCode,
    lastSyncedAt: record.lastSyncedAt,
    autoSyncEnabled: record.autoSyncEnabled,
    onboardedAt: record.onboardedAt,
    detectedCountryCode: record.detectedCountryCode,
    needsRateConfirmation: record.needsRateConfirmation,
    settings: {
      pricesIncludeTax: record.pricesIncludeTax,
      taxRatePct: toNumber(record.taxRatePct),
      targetMarginPct: toNumber(record.targetMarginPct),
      warnMarginPct: toNumber(record.warnMarginPct),
      criticalMarginPct: toNumber(record.criticalMarginPct),
    },
    rules: record.costRules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      kind: rule.kind,
      value: toNumber(rule.value),
      enabled: rule.enabled,
    })),
  };
}

export interface UpdateSettingsInput {
  currencyCode?: string;
  pricesIncludeTax?: boolean;
  taxRatePct?: number;
  targetMarginPct?: number;
  warnMarginPct?: number;
  criticalMarginPct?: number;
  autoSyncEnabled?: boolean;
}

export async function updateShopSettings(
  shop: string,
  input: UpdateSettingsInput,
) {
  return prisma.shopSettings.upsert({
    where: { shop },
    create: { shop, ...input },
    update: input,
  });
}

export async function upsertCostRule(
  shop: string,
  input: {
    id?: string;
    name: string;
    kind: CostRule["kind"];
    value: number;
    enabled: boolean;
  },
) {
  if (input.id) {
    // Scoped by shop as well as id so a crafted form post cannot edit another
    // shop's rule.
    const { count } = await prisma.costRule.updateMany({
      where: { id: input.id, shop },
      data: {
        name: input.name,
        kind: input.kind,
        value: input.value,
        enabled: input.enabled,
      },
    });
    return count > 0;
  }

  const maxOrder = await prisma.costRule.aggregate({
    where: { shop },
    _max: { sortOrder: true },
  });

  await prisma.costRule.create({
    data: {
      shop,
      name: input.name,
      kind: input.kind,
      value: input.value,
      enabled: input.enabled,
      sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
    },
  });
  return true;
}

export async function deleteCostRule(shop: string, id: string) {
  const { count } = await prisma.costRule.deleteMany({ where: { id, shop } });
  return count > 0;
}
