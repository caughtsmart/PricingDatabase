import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

/**
 * The product details margin widget.
 *
 * All arithmetic happens on the app backend so that this widget and the
 * dashboard can never disagree — this file only renders what `/api/margin`
 * returns and posts edits back. `fetch` with a relative URL is resolved against
 * the app's application_url by Shopify, which also attaches the ID token, so
 * there is no token plumbing here.
 */

export default async () => {
  render(<ProductMarginBlock />, document.body);
};

interface VariantExtras {
  freight: number;
  duty: number;
  packaging: number;
  handling: number;
  other: number;
  notes: string | null;
}

type CostRuleKind =
  | "PERCENT_OF_REVENUE"
  | "FIXED_PER_UNIT"
  | "PERCENT_OF_COST"
  | "FIXED_PER_ORDER"
  | "RATE_TIMES_COST"
  | "PER_DAY_HELD";

interface AppliedCost {
  id: string;
  name: string;
  kind: CostRuleKind;
  value: number;
  amount: number;
}

type WaterfallTone = "neutral" | "info" | "warning" | "critical" | "success";

interface WaterfallSegment {
  key: string;
  label: string;
  amount: number;
  share: number;
  kind: "tax" | "cost" | "profit";
  tone: WaterfallTone;
}

interface Waterfall {
  price: number;
  segments: WaterfallSegment[];
  isLoss: boolean;
  hasCostData: boolean;
}

type MarginStatus = "unknown" | "loss" | "critical" | "warn" | "healthy";

interface MarginResult {
  grossRevenue: number;
  netRevenue: number;
  taxAmount: number;
  unitCost: number;
  extraUnitCost: number;
  landedUnitCost: number;
  appliedCosts: AppliedCost[];
  totalVariableCost: number;
  totalCost: number;
  grossProfit: number;
  grossMarginPct: number;
  netProfit: number;
  netMarginPct: number;
  markupPct: number;
  breakEvenPrice: number | null;
  targetPrice: number | null;
  discountPct: number | null;
  status: MarginStatus;
  hasCostData: boolean;
}

interface VariantPayload {
  variantId: string;
  inventoryItemId: string | null;
  title: string | null;
  sku: string | null;
  price: number;
  inventoryQuantity: number;
  extras: VariantExtras;
  margin: MarginResult;
  waterfall: Waterfall;
}

interface MarginApiPayload {
  productId: string;
  productTitle: string;
  currencyCode: string;
  targetMarginPct: number;
  variants: VariantPayload[];
  appliedRuleNames: string[];
}

const EXTRA_FIELDS = [
  { key: "freight", label: "Freight" },
  { key: "duty", label: "Duty" },
  { key: "packaging", label: "Packaging" },
  { key: "handling", label: "Handling" },
  { key: "other", label: "Other" },
] as const;

type ExtraKey = (typeof EXTRA_FIELDS)[number]["key"];

function statusTone(status: MarginStatus) {
  switch (status) {
    case "loss":
    case "critical":
      return "critical";
    case "warn":
      return "warning";
    case "healthy":
      return "success";
    default:
      return "neutral";
  }
}

function statusLabel(status: MarginStatus) {
  switch (status) {
    case "loss":
      return "Losing money";
    case "critical":
      return "Critical";
    case "warn":
      return "Below target";
    case "healthy":
      return "Healthy";
    default:
      return "No cost set";
  }
}

function money(value: number, currency: string) {
  try {
    return shopify.i18n.formatCurrency(value, { currency });
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function percent(value: number) {
  return `${value.toFixed(1)}%`;
}

function toAmount(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function ProductMarginBlock() {
  const productId = shopify.data?.selected?.[0]?.id as string | undefined;

  const [payload, setPayload] = useState<MarginApiPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftExtras, setDraftExtras] = useState<Record<ExtraKey, string>>({
    freight: "0",
    duty: "0",
    packaging: "0",
    handling: "0",
    other: "0",
  });
  const [draftUnitCost, setDraftUnitCost] = useState("0");
  const [dirty, setDirty] = useState(false);
  // Block extensions have no toast API (that is App Home only), so saving is
  // confirmed inline instead.
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    if (!productId) {
      setError("No product selected.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/margin?productId=${encodeURIComponent(productId)}`,
      );
      if (!response.ok) {
        throw new Error(`Could not load margin data (${response.status}).`);
      }
      const data = (await response.json()) as MarginApiPayload;
      setPayload(data);
      setSelectedId((current) => current ?? data.variants[0]?.variantId ?? null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Could not load margin data.",
      );
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(() => {
    if (!payload) return null;
    return (
      payload.variants.find((variant) => variant.variantId === selectedId) ??
      payload.variants[0] ??
      null
    );
  }, [payload, selectedId]);

  // Reset the draft whenever a different variant is chosen, so edits never leak
  // from one variant onto another.
  useEffect(() => {
    if (!selected) return;
    setDraftExtras({
      freight: String(selected.extras.freight),
      duty: String(selected.extras.duty),
      packaging: String(selected.extras.packaging),
      handling: String(selected.extras.handling),
      other: String(selected.extras.other),
    });
    setDraftUnitCost(String(selected.margin.unitCost));
    setDirty(false);
  }, [selected?.variantId]);

  const save = useCallback(async () => {
    if (!selected || !payload) return;

    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/margin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variantId: selected.variantId,
          productId: payload.productId,
          inventoryItemId: selected.inventoryItemId,
          unitCost: toAmount(draftUnitCost),
          price: selected.price,
          extras: {
            freight: toAmount(draftExtras.freight),
            duty: toAmount(draftExtras.duty),
            packaging: toAmount(draftExtras.packaging),
            handling: toAmount(draftExtras.handling),
            other: toAmount(draftExtras.other),
          },
        }),
      });

      const result = (await response.json()) as {
        ok?: boolean;
        userErrors?: string[];
        error?: string;
      };

      if (!response.ok || result.error) {
        throw new Error(result.error ?? "Could not save.");
      }
      if (result.userErrors?.length) {
        throw new Error(result.userErrors.join(" "));
      }

      // Re-read rather than patching local state: this picks up the unit cost
      // exactly as Shopify stored it, so what is shown is what is saved.
      await load();
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }, [selected, payload, draftExtras, draftUnitCost, load]);

  if (loading) {
    return (
      <s-admin-block heading="Margin">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-spinner />
          <s-text>Working out your margin…</s-text>
        </s-stack>
      </s-admin-block>
    );
  }

  if (error && !payload) {
    return (
      <s-admin-block heading="Margin">
        <s-banner tone="critical">
          <s-paragraph>{error}</s-paragraph>
        </s-banner>
      </s-admin-block>
    );
  }

  if (!payload || !selected) {
    return (
      <s-admin-block heading="Margin">
        <s-paragraph>No variants found for this product.</s-paragraph>
      </s-admin-block>
    );
  }

  const { margin } = selected;
  const currency = payload.currencyCode;
  const fmt = (value: number) => money(value, currency);
  const multiVariant = payload.variants.length > 1;

  return (
    <s-admin-block heading="Margin">
      <s-stack direction="block" gap="base">
        {error ? (
          <s-banner tone="critical">
            <s-paragraph>{error}</s-paragraph>
          </s-banner>
        ) : null}

        {multiVariant ? (
          <s-select
            label="Variant"
            value={selected.variantId}
            onInput={(event: Event) =>
              setSelectedId((event.target as HTMLSelectElement).value)
            }
          >
            {payload.variants.map((variant) => (
              <s-option key={variant.variantId} value={variant.variantId}>
                {variant.title && variant.title !== "Default Title"
                  ? variant.title
                  : (variant.sku ?? "Default")}
              </s-option>
            ))}
          </s-select>
        ) : null}

        {/* Headline: the number the merchant came here for. */}
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone={statusTone(margin.status)}>
            {statusLabel(margin.status)}
          </s-badge>
          <s-heading>
            {margin.hasCostData ? percent(margin.netMarginPct) : "—"}
          </s-heading>
          <s-text color="subdued">
            net margin · {fmt(margin.netProfit)} per unit
          </s-text>
        </s-stack>

        {!margin.hasCostData ? (
          <s-banner tone="warning">
            <s-paragraph>
              No cost per item is set for this variant, so this margin is not
              real yet. Enter a unit cost below to fix it.
            </s-paragraph>
          </s-banner>
        ) : null}

        {/* The money waterfall: the price as one bar, each cost taking its
            bite, profit (or loss) last. Proportion lives in the bar; status
            colour lives in the detail text — the extension sandbox only
            allows neutral background fills (transparent/base/subdued/strong),
            so the DESIGN.md ambition of a coloured profit segment is carried
            by the selected-segment detail and the badge above instead. */}
        <MoneyWaterfall waterfall={selected.waterfall} fmt={fmt} />

        {/* The full walk from price down to profit. */}
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-stack direction="block" gap="small-400">
            <Row label="Price" value={fmt(margin.grossRevenue)} />
            {margin.taxAmount > 0 ? (
              <Row label="Less tax" value={`− ${fmt(margin.taxAmount)}`} subdued />
            ) : null}
            <Row label="Revenue you keep" value={fmt(margin.netRevenue)} strong />
            <s-divider />
            <Row label="Unit cost" value={`− ${fmt(margin.unitCost)}`} subdued />
            {margin.extraUnitCost > 0 ? (
              <Row
                label="Freight, duty, packaging, handling"
                value={`− ${fmt(margin.extraUnitCost)}`}
                subdued
              />
            ) : null}
            <Row label="Landed cost" value={fmt(margin.landedUnitCost)} strong />
            {margin.appliedCosts.map((cost) => (
              <Row
                key={cost.id}
                label={ruleLabel(cost)}
                value={`− ${fmt(cost.amount)}`}
                subdued
              />
            ))}
            <s-divider />
            <Row label="Net profit" value={fmt(margin.netProfit)} strong />
          </s-stack>
        </s-box>

        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <Stat
            label="Break-even price"
            value={margin.breakEvenPrice === null ? "—" : fmt(margin.breakEvenPrice)}
          />
          <Stat
            label={`Price for ${percent(payload.targetMarginPct)}`}
            value={margin.targetPrice === null ? "—" : fmt(margin.targetPrice)}
          />
          <Stat label="Markup on cost" value={percent(margin.markupPct)} />
          <Stat
            label="Profit if stock sells"
            value={fmt(margin.netProfit * selected.inventoryQuantity)}
          />
        </s-grid>

        {margin.discountPct !== null ? (
          <s-text color="subdued">
            Currently discounted {percent(margin.discountPct)} from the compare-at
            price.
          </s-text>
        ) : null}

        {/* Cost entry. */}
        <s-heading>Cost breakdown</s-heading>
        <s-money-field
          label="Unit cost (Shopify cost per item)"
          value={draftUnitCost}
          onInput={(event: Event) => {
            setDraftUnitCost((event.target as HTMLInputElement).value);
            setDirty(true);
            setSaved(false);
          }}
        />
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          {EXTRA_FIELDS.map((field) => (
            <s-money-field
              key={field.key}
              label={field.label}
              value={draftExtras[field.key]}
              onInput={(event: Event) => {
                const next = (event.target as HTMLInputElement).value;
                setDraftExtras((current) => ({ ...current, [field.key]: next }));
                setDirty(true);
                setSaved(false);
              }}
            />
          ))}
        </s-grid>

        {payload.appliedRuleNames.length > 0 ? (
          <s-text color="subdued">
            Shop-wide costs applied: {payload.appliedRuleNames.join(", ")}.
          </s-text>
        ) : null}

        <s-stack direction="inline" gap="base">
          <s-button
            variant="primary"
            disabled={saving || !dirty}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save costs"}
          </s-button>
          <s-button
            variant="secondary"
            disabled={saving || !dirty}
            onClick={() => void load()}
          >
            Discard
          </s-button>
          {saved ? <s-text tone="success">Saved</s-text> : null}
        </s-stack>

        <SolvePanel
          key={selected.variantId}
          variantId={selected.variantId}
          productId={payload.productId}
          currentPrice={selected.price}
          unitCost={toAmount(draftUnitCost)}
          extras={{
            freight: toAmount(draftExtras.freight),
            duty: toAmount(draftExtras.duty),
            packaging: toAmount(draftExtras.packaging),
            handling: toAmount(draftExtras.handling),
            other: toAmount(draftExtras.other),
          }}
          defaultTargetPct={payload.targetMarginPct}
          fmt={fmt}
          onPriceApplied={() => void load()}
        />
      </s-stack>
    </s-admin-block>
  );
}

interface SolveResponse {
  solvable?: boolean;
  price?: number;
  margin?: MarginResult;
  reason?: string;
  error?: string;
}

/**
 * Lock-and-solve (DESIGN.md §6): the costs hold still, the merchant names a
 * margin, and the price solves itself — on the server, since the widget never
 * computes. Solving uses the draft costs exactly as typed, so what-if play is
 * free; nothing persists until the merchant explicitly sets the price.
 */
function SolvePanel({
  variantId,
  productId,
  currentPrice,
  unitCost,
  extras,
  defaultTargetPct,
  fmt,
  onPriceApplied,
}: {
  variantId: string;
  productId: string;
  currentPrice: number;
  unitCost: number;
  extras: Record<ExtraKey, number>;
  defaultTargetPct: number;
  fmt: (value: number) => string;
  onPriceApplied: () => void;
}) {
  const [targetPct, setTargetPct] = useState(String(defaultTargetPct));
  const [quote, setQuote] = useState<{ price: number; margin: MarginResult } | null>(null);
  const [solveError, setSolveError] = useState<string | null>(null);
  const [solving, setSolving] = useState(false);
  // Two-step apply: first tap arms, second confirms. Changing the price of a
  // live product deserves a deliberate second tap, not a slip of the thumb.
  const [armedPrice, setArmedPrice] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  const hasCost = unitCost > 0;

  // Re-solve, debounced, whenever the target or the draft costs move. Each
  // solve is a server round trip; the debounce keeps typing from becoming a
  // request per keystroke.
  useEffect(() => {
    setArmedPrice(null);
    setApplied(false);

    if (!hasCost) {
      setQuote(null);
      setSolveError(null);
      return;
    }
    const target = Number(targetPct);
    if (!Number.isFinite(target) || target >= 100) {
      setQuote(null);
      setSolveError(target >= 100 ? "A margin of 100% would mean the product cost nothing at all." : null);
      return;
    }

    const timer = setTimeout(() => {
      setSolving(true);
      setSolveError(null);
      fetch("/api/margin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: "solve",
          variantId,
          productId,
          unitCost,
          extras,
          targetMarginPct: target,
        }),
      })
        .then((response) => response.json() as Promise<SolveResponse>)
        .then((data) => {
          if (data.solvable && typeof data.price === "number" && data.margin) {
            setQuote({ price: data.price, margin: data.margin });
          } else {
            setQuote(null);
            setSolveError(data.reason ?? data.error ?? "Could not solve a price.");
          }
        })
        .catch(() => {
          setQuote(null);
          setSolveError("Could not reach the app to solve a price.");
        })
        .finally(() => setSolving(false));
    }, 450);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetPct, unitCost, extras.freight, extras.duty, extras.packaging, extras.handling, extras.other]);

  async function applyPrice(price: number) {
    setApplying(true);
    try {
      const response = await fetch("/api/margin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: "apply-price", variantId, productId, price }),
      });
      const data = (await response.json()) as { ok?: boolean; userErrors?: string[]; error?: string };
      if (!response.ok || data.error || data.userErrors?.length) {
        setSolveError(data.userErrors?.join(" ") ?? data.error ?? "Could not set the price.");
        return;
      }
      setApplied(true);
      setArmedPrice(null);
      onPriceApplied();
    } catch {
      setSolveError("Could not reach the app to set the price.");
    } finally {
      setApplying(false);
    }
  }

  const delta = quote ? quote.price - currentPrice : 0;

  return (
    <s-stack direction="block" gap="small-400">
      <s-heading>What should this sell for?</s-heading>

      {!hasCost ? (
        <s-text color="subdued">
          Enter a unit cost above first — a price solved from no cost would be
          fiction.
        </s-text>
      ) : (
        <>
          <s-number-field
            label="Margin you want"
            suffix="%"
            min={-50}
            max={99}
            step={0.5}
            value={targetPct}
            onInput={(event: Event) =>
              setTargetPct((event.target as HTMLInputElement).value)
            }
          />

          {solveError ? (
            <s-text tone="critical">{solveError}</s-text>
          ) : quote ? (
            <s-stack direction="block" gap="small-500">
              <s-text type="strong" fontVariantNumeric="tabular-nums">
                Charge {fmt(quote.price)} → {fmt(quote.margin.netProfit)} profit
                a unit
              </s-text>
              <s-text color="subdued">
                {Math.abs(delta) < 0.005
                  ? "That is today's price."
                  : delta > 0
                    ? `${fmt(delta)} above today's ${fmt(currentPrice)}.`
                    : `${fmt(-delta)} below today's ${fmt(currentPrice)} — room to cut.`}
              </s-text>
              <s-stack direction="inline" gap="base" alignItems="center">
                {armedPrice === quote.price ? (
                  <s-button
                    variant="primary"
                    tone="critical"
                    disabled={applying}
                    onClick={() => void applyPrice(quote.price)}
                  >
                    {applying ? "Setting…" : `Confirm ${fmt(quote.price)}`}
                  </s-button>
                ) : (
                  <s-button
                    variant="secondary"
                    disabled={applying || Math.abs(delta) < 0.005}
                    onClick={() => setArmedPrice(quote.price)}
                  >
                    Set price to {fmt(quote.price)}
                  </s-button>
                )}
                {armedPrice === quote.price ? (
                  <s-button variant="tertiary" onClick={() => setArmedPrice(null)}>
                    Cancel
                  </s-button>
                ) : null}
                {applied ? <s-text tone="success">Price updated</s-text> : null}
              </s-stack>
            </s-stack>
          ) : solving ? (
            <s-text color="subdued">Working it out…</s-text>
          ) : null}
        </>
      )}
    </s-stack>
  );
}

/**
 * A rule's display label, always saying what its number is measured against.
 * "3%" means very different money against the price than against the cost.
 */
function ruleLabel(cost: AppliedCost): string {
  switch (cost.kind) {
    case "PERCENT_OF_REVENUE":
      return `${cost.name} (${cost.value}% of revenue)`;
    case "PERCENT_OF_COST":
      return `${cost.name} (${cost.value}% of cost)`;
    case "RATE_TIMES_COST":
      return `${cost.name} (${cost.value}% loss rate)`;
    case "FIXED_PER_ORDER":
      return `${cost.name} (per order)`;
    case "PER_DAY_HELD":
      return `${cost.name} (per day in stock)`;
    default:
      return cost.name;
  }
}

/** Maps a waterfall tone onto the s-text tone scale. */
function textTone(
  tone: WaterfallTone,
): "neutral" | "info" | "warning" | "critical" | "success" {
  return tone === "neutral" ? "neutral" : tone;
}

function MoneyWaterfall({
  waterfall,
  fmt,
}: {
  waterfall: Waterfall;
  fmt: (value: number) => string;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  if (waterfall.price <= 0 || waterfall.segments.length === 0) return null;

  // Absolute shares, floored so a sliver of a segment is still tappable.
  // DESIGN.md says never to squeeze a label into a sliver — labels live in
  // the detail line below, so the floor only buys touch area.
  const drawable = waterfall.segments.map((segment) => ({
    ...segment,
    width: Math.max(Math.abs(segment.share), 0.04),
  }));
  const columns = drawable
    .map((segment) => `${segment.width.toFixed(4)}fr`)
    .join(" ");

  // Neutral fills are all the sandbox offers, so adjacent segments alternate
  // shades and profit takes the strongest.
  const shadeFor = (segment: WaterfallSegment, index: number) =>
    segment.kind === "profit" ? "strong" : index % 2 === 0 ? "subdued" : "base";

  const selected =
    waterfall.segments.find((segment) => segment.key === selectedKey) ?? null;
  const profit = waterfall.segments[waterfall.segments.length - 1];

  return (
    <s-stack direction="block" gap="small-500">
      <s-grid gridTemplateColumns={columns}>
        {drawable.map((segment, index) => (
          <s-clickable
            key={segment.key}
            background={shadeFor(segment, index)}
            minBlockSize="14px"
            accessibilityLabel={`${segment.label}: ${fmt(segment.amount)}`}
            onClick={() =>
              setSelectedKey((current) =>
                current === segment.key ? null : segment.key,
              )
            }
          />
        ))}
      </s-grid>

      {selected ? (
        <s-text tone={textTone(selected.tone)}>
          {selected.label}: {fmt(selected.amount)} ·{" "}
          {(selected.share * 100).toFixed(1)}% of the price
        </s-text>
      ) : (
        <s-text color="subdued">
          Every part of the price, in order — tap a segment.{" "}
          {waterfall.isLoss
            ? `Costs overrun the price by ${fmt(Math.abs(profit.amount))} a unit.`
            : `The last block is your ${profit.label.toLowerCase()}.`}
        </s-text>
      )}
    </s-stack>
  );
}

function Row({
  label,
  value,
  strong,
  subdued,
}: {
  label: string;
  value: string;
  strong?: boolean;
  subdued?: boolean;
}) {
  return (
    <s-stack direction="inline" justifyContent="space-between" gap="base">
      <s-text color={subdued ? "subdued" : "base"}>{label}</s-text>
      <s-text
        type={strong ? "strong" : "generic"}
        fontVariantNumeric="tabular-nums"
      >
        {value}
      </s-text>
    </s-stack>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <s-stack direction="block" gap="small-500">
      <s-text color="subdued">{label}</s-text>
      <s-text type="strong" fontVariantNumeric="tabular-nums">
        {value}
      </s-text>
    </s-stack>
  );
}
