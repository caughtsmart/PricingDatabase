import type { VariantCostInputs } from "./margin";

/**
 * Resolving a variant's cost blocks (MARGIN-MODEL.md §2) into engine inputs.
 *
 * A block is a number *or* a formula of its children: a GROUP with children
 * sums them; a GROUP without children acts as its own collapsed value. That
 * one rule is what lets a forensic landed-cost breakdown sit next to a
 * hand-waved "£1 for the rest of it" in the same variant.
 *
 * Kept pure and Prisma-free so the tree rules — especially the cycle guard —
 * are tested directly. A parentId loop in the data must degrade to "those
 * blocks are ignored", never to a hung request.
 */

/** The kinds a variant-level block may carry. Shop-wide rules have their own six. */
export type ComponentKind = "FIXED_PER_UNIT" | "PERCENT_OF_COST" | "GROUP";

export type ComponentConfidence = "KNOWN" | "ESTIMATED" | "GUESSED";

/**
 * What a percent block is measured against (MARGIN-MODEL.md §2.3: a
 * percentage is meaningless until it declares its base). Fixed blocks and
 * groups ignore it — a flat amount has no denominator.
 */
export type ComponentBase = "LANDED_COST" | "NET_REVENUE" | "GROSS_PRICE";

export interface CostComponentInput {
  id: string;
  parentId?: string | null;
  label: string;
  kind: ComponentKind;
  /** Currency for FIXED_PER_UNIT and collapsed GROUPs; % points for PERCENT_OF_COST. */
  value: number;
  /** Denominator for PERCENT_OF_COST blocks; defaults to the goods cost. */
  base?: ComponentBase;
  confidence?: ComponentConfidence;
  enabled?: boolean;
  sortOrder?: number;
}

export interface ResolvedComponents {
  /** Σ flat per-unit additions to landed cost. */
  extraFixed: number;
  /** Σ percent-of-goods rates, in % points. */
  extraCostPct: number;
  /** Σ percent-of-net-revenue rates, in % points. */
  extraRevenuePct: number;
  /** Σ percent-of-gross-price rates, in % points. */
  extraGrossPct: number;
  /** Ids that were skipped because they sit in a parentId cycle. */
  cyclic: string[];
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Flattens a component tree into the two numbers the engine needs.
 *
 * - Disabled (muted) blocks contribute nothing, and muting a GROUP mutes its
 *   whole subtree — that is what a mute toggle on a group means.
 * - A GROUP's own `value` is only used when it has no enabled children.
 * - Blocks whose parent chain never reaches a root (orphans pointing at
 *   missing ids, or cycles) are skipped and reported, not summed: silently
 *   including a mis-parented block would double-count it somewhere.
 */
export function resolveComponents(
  components: CostComponentInput[],
): ResolvedComponents {
  const byId = new Map(components.map((component) => [component.id, component]));
  const childrenOf = new Map<string, CostComponentInput[]>();
  for (const component of components) {
    if (!component.parentId) continue;
    const siblings = childrenOf.get(component.parentId) ?? [];
    siblings.push(component);
    childrenOf.set(component.parentId, siblings);
  }

  // A block only counts if its ancestor chain reaches a root without looping
  // and with every ancestor enabled.
  const cyclic: string[] = [];
  function chainStatus(component: CostComponentInput): "ok" | "muted" | "broken" {
    const seen = new Set<string>([component.id]);
    let current = component;
    while (current.parentId) {
      const parent = byId.get(current.parentId);
      if (!parent || seen.has(parent.id)) return "broken";
      if (parent.enabled === false) return "muted";
      seen.add(parent.id);
      current = parent;
    }
    return "ok";
  }

  let extraFixed = 0;
  let extraCostPct = 0;
  let extraRevenuePct = 0;
  let extraGrossPct = 0;

  for (const component of components) {
    if (component.enabled === false) continue;

    const status = chainStatus(component);
    if (status === "broken") {
      cyclic.push(component.id);
      continue;
    }
    if (status === "muted") continue;

    const enabledChildren = (childrenOf.get(component.id) ?? []).filter(
      (child) => child.enabled !== false,
    );

    switch (component.kind) {
      case "GROUP":
        // With enabled children the group is a container — the children carry
        // the numbers. Without any, it collapses to its own fixed value.
        if (enabledChildren.length === 0) extraFixed += num(component.value);
        break;
      case "FIXED_PER_UNIT":
        extraFixed += num(component.value);
        break;
      case "PERCENT_OF_COST":
        // The base override (§2.3): the same 3% is very different money
        // against the goods cost, the kept revenue, or the full price.
        switch (component.base ?? "LANDED_COST") {
          case "NET_REVENUE":
            extraRevenuePct += num(component.value);
            break;
          case "GROSS_PRICE":
            extraGrossPct += num(component.value);
            break;
          default:
            extraCostPct += num(component.value);
        }
        break;
    }
  }

  return { extraFixed, extraCostPct, extraRevenuePct, extraGrossPct, cyclic };
}

/** Resolves blocks straight into the engine's cost-input shape. */
export function componentsToCostInputs(
  unitCost: number | null,
  components: CostComponentInput[],
): VariantCostInputs {
  const resolved = resolveComponents(components);
  return {
    unitCost,
    extraFixed: resolved.extraFixed,
    extraCostPct: resolved.extraCostPct,
    extraRevenuePct: resolved.extraRevenuePct,
    extraGrossPct: resolved.extraGrossPct,
  };
}
