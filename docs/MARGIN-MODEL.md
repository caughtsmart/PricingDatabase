# The cost model

Where the margin engine is going, and how to get it there without breaking the
tests. Read this before changing `VariantCost`, `CostRule` or
`solvePriceForMargin`.

---

## 1. The problem with today's model

Two limitations, both deliberate v1 shortcuts, both now blocking:

**`VariantCost` has five fixed columns.**

```
freight · duty · packaging · handling · other
```

An importer needs FX spread, customs brokerage and repackaging labour. They get
one box called `other`, and by next month nobody remembers what is in it. A
first-time seller needs none of the five and is confronted by all of them. The
same schema is simultaneously too detailed and not detailed enough — which is
the exact complaint that started this project.

**`CostRuleKind` has two members.**

```
PERCENT_OF_REVENUE · FIXED_PER_UNIT
```

Which means the app currently cannot express:

- **Returns** — a rate multiplied by a cost, not a flat charge
- **Pick and pack per order** — needs dividing by units per order
- **Storage / cost of capital** — a charge per unit per day held
- **Duty** — genuinely a percentage of *landed cost*, not a flat amount.
  Today it is a fixed column, so every price break, FX move or supplier
  increase silently makes it wrong.

## 2. The target: cost blocks

A margin model is an **ordered stack of blocks** under a price, not a form.

```
PRICE
 ├─ tax                (extracted)
 ├─ landed cost        (group → trade, freight, duty, FX)
 ├─ payment fee        (% of net)
 ├─ pick & pack        (per order ÷ basket)
 ├─ returns            (rate × cost)
 └─ storage            (per day held)
= NET PROFIT
```

### 2.1 Block kinds — the whole engine in seven shapes

| Kind | Maths | Example |
|---|---|---|
| `FIXED_PER_UNIT` | flat amount | trade price, retail packaging |
| `PERCENT_OF_REVENUE` | % × net revenue | payment fee, marketplace commission |
| `PERCENT_OF_COST` | % × landed cost | import duty, supplier surcharge |
| `FIXED_PER_ORDER` | amount ÷ units per order | pick & pack, courier label, box |
| `RATE_TIMES_COST` | probability × impact | returns, breakage, shrinkage |
| `PER_DAY_HELD` | amount/day × days on hand | storage, capital tied up in stock |
| `GROUP` | sum of children | "Landed cost", "Selling fees" |

The first two exist. The rest are additive to the enum — no data loss.

### 2.2 The rule that fixes "too detailed vs not detailed enough"

**Every block is a number *or* a formula of its children.**

- Collapsed: `Landed cost = £8.40` — typed in, good enough, move on
- Expanded: `Landed cost = trade £7.10 + freight £0.62 + duty 4.5% + FX 1.2%`

Same block, two zoom levels, chosen **per block**. A merchant can have a
forensic landed-cost block sitting next to a hand-waved "£1 for the rest of it",
and the engine does not care. That is what `parentId` buys.

### 2.3 Percentages must declare their base

A percentage is meaningless until it says what it is a percentage *of*:

```
net_revenue     — most commissions
gross_price     — card processing is charged on the gross
landed_cost     — duty
```

Getting this wrong is a silent 2–4% error. Make `base` an explicit column and
an explicit dropdown in the UI, never an assumption in the code.

### 2.4 Scope — templates for free

Add `scope` to `CostRule`: `SHOP | VENDOR | PRODUCT_TYPE | VARIANT`, with the
**most specific match winning**. One column gives you per-vendor rules,
per-channel rules and inherit-with-override, without a second table. Games
Workshop at 35% trade and a TCG distributor at 12% stop sharing one rule set.

### 2.5 Confidence

Tag each value `KNOWN | ESTIMATED | GUESSED`. It drives:

- A band on the headline figure — *"31% margin, likely 26–36%"*
- A "tighten this up" list, ranked by how much certainty each guess costs
- The honest message that a model is a range, not gospel

## 3. Migration path

Four steps, each independently shippable, none of which breaks the existing
tests if done in order.

> **Status:** steps 1–3 are shipped. All six kinds exist in `CostRuleKind`
> (schema and engine), amounts resolve against their declared bases, and the
> solver uses the generalised closed form below with its round-trip tests
> intact. `FIXED_PER_ORDER` divides by `ShopSettings.avgUnitsPerOrder`;
> `PER_DAY_HELD` multiplies by a per-variant days-of-cover estimate
> (`daysHeldEstimate` in `margin.ts`) derived from synced stock and 90-day
> sales. Step 4 — replacing `VariantCost`'s columns with `CostComponent` rows —
> remains open, and with it grouping (`parentId`), per-rule `base` overrides,
> `scope` and `confidence`.

### Step 1 — extend the enum

Add `PERCENT_OF_COST`, `FIXED_PER_ORDER`, `RATE_TIMES_COST`, `PER_DAY_HELD` to
`CostRuleKind`. Purely additive. Existing rows keep working.

### Step 2 — generalise the reducer

Replace `percentRate()` and `fixedPerUnit()` — which currently sum every
percentage against `netRevenue` — with an ordered reduce that resolves each
block's `base` before applying it. Keep the summing behaviour for the two
existing kinds so current results are unchanged, and cover that with a
regression test.

### Step 3 — generalise the solver

This is the step that will bite. `solvePriceForMargin` assumes all percentages
are of revenue. With `PERCENT_OF_COST` in the mix:

```
netProfit = netRev − landed − netRev·r − landed·c − fixed
```

Setting `netProfit = m · netRev` and solving:

```
netRev · (1 − r − m) = landed · (1 + c) + fixed

netRev = (landed · (1 + c) + fixed) / (1 − r − m)
```

where

- `r` = Σ percent-of-revenue rates
- `c` = Σ percent-of-cost rates
- `m` = desired margin
- `fixed` = Σ per-unit + Σ(per-order ÷ units per order) + Σ(rate × impact)
  + Σ(per-day × days held)

Still closed form, still one expression, break-even is `m = 0`. The existing
guard — return `null` when the denominator is `<= 1e-9` — still applies, and
still means "the percentage costs plus your target margin consume 100% or more
of revenue, so no finite price gets you there".

**Keep the round-trip tests.** Feed the solved price back through
`calculateMargin` and assert the margin lands on target. That is the only thing
that catches an algebra slip.

### Step 4 — replace `VariantCost`'s columns with rows

New table:

```prisma
model CostComponent {
  id         String   @id @default(cuid())
  shop       String
  variantId  String?           // null when this is a template/scoped block
  productId  String?
  parentId   String?           // GROUP nesting — collapse/explode
  label      String
  kind       CostRuleKind
  base       CostBase @default(NET_REVENUE)
  value      Decimal  @db.Decimal(12, 4)
  confidence Confidence @default(ESTIMATED)
  enabled    Boolean  @default(true)
  sortOrder  Int      @default(0)
  @@index([shop, variantId])
}
```

Migrate the five columns into five rows per variant. Keep
`sumExtraUnitCost(costs)` as a thin adapter over the new rows during the
transition so the widget and the existing tests stay green, then delete it.

## 4. Progressive disclosure

The block model only helps if the UI does not show all of it at once. Three
levels; the level controls **default visibility**, never what exists underneath.

**Level 1 — "Am I losing money?"**
Price, cost, tax-inclusive toggle. One big number, one sentence, one nudge:
*"Most sellers forget three things — payment fees, postage, returns. Add them?"*
One tap adds three pre-filled blocks.

**Level 2 — "The real number"**
Transaction, fulfilment, marketing and returns blocks. Basket size. Break-even.

**Level 3 — "Full unit economics"**
Landed-cost explosion, holding costs, overhead allocation, GMROI, per channel.

Moving up a level never re-asks anything. Moving down hides, never deletes,
and shows a "3 hidden blocks" chip so nothing is silently excluded.

## 5. Overheads: off by default

Rent, salaries and software allocation stay **off** until Level 3, with a note:

> Don't spread the rent across products yet. First check every product earns a
> contribution. Then check the total contribution covers the rent.

Beginners who allocate overheads too early get a frightening number and
panic-price. Contribution margin first is both more correct and less alarming.

## 6. Two things to keep displaying, permanently

- **Markup and margin, side by side.** "I add 50% so I make 50%" is the most
  expensive misunderstanding in small business. 50% markup is a 33% margin.
  This does not belong in a tooltip.
- **"Explain this number."** Every output traces to a plain-English line-by-line
  walk of the maths. The engine already returns every intermediate figure —
  `netRevenue`, `taxAmount`, `landedUnitCost`, `appliedCosts[]` — precisely so
  this is possible without recomputation.

## 7. Cost taxonomy — the content model

The block palette, grouped by family. Not all of this ships; it is the
vocabulary the app should eventually understand.

**Revenue side** — list price, channel price variance, tax inclusive/exclusive,
promotional discount, coupon redemption rate × value, loyalty points issued,
shipping revenue charged, refund/cancellation rate, chargebacks.

**Direct cost, bought-in** — trade price, quantity break pricing, MOQ effects,
settlement discount, supplier rebates and retros.

**Direct cost, made** — bill of materials, direct labour (minutes × loaded
rate incl. employer NI and pension), machine time, yield/scrap rate, rework
rate, batch setup ÷ batch size.

**Landed cost** — inbound freight (allocated by unit, weight, volume or
value — make it a choice), import duty, customs clearance ÷ units, port and
handling, FX rate plus bank spread (0.5–3%, usually invisible), inbound
insurance, inspection.

**Physical prep** — retail packaging, labelling, barcoding, security tagging,
assembly and kitting labour, repackaging damaged retail boxes.

**Per transaction** — payment processing (% + fixed, varying by card type and
region), marketplace commission, marketplace subscription ÷ units, fulfilment
fee, outbound shipping vs shipping charged, box/void fill/tape/label, parcel
insurance, payout fees.

**Variable marketing** — attributable ad spend per unit, blended CAC ÷ units,
affiliate and influencer commission, sponsored ads, samples ÷ units sold.

**Post-sale and risk** — return rate × (postage + inspection + repack), % of
returns unsellable, warranty rate, support minutes × loaded rate, damage in
transit, shrinkage, markdown provision, obsolescence write-off, spoilage.

**Holding** — cost of capital (value × annual rate × days on hand ÷ 365),
storage per unit per month, 3PL long-term storage surcharges, stock insurance,
stock-count labour.

**Overheads** — rent, rates, utilities, salaries, software, accountancy,
insurance, bank charges, depreciation. Allocation methods: per unit sold, per
order, % of revenue, % of COGS, per square foot, activity-based, or **don't
allocate** (the recommended default).

## 8. Outputs

| Output | Formula | Level |
|---|---|---|
| Gross profit | net revenue − landed cost | 1 |
| Gross margin % | GP ÷ net revenue | 1 |
| Markup % | profit ÷ cost | 1 (beside margin, always) |
| Net profit / margin % | after all variable costs | 1 |
| Break-even price | price where net profit = 0 | 1 |
| Target price | price hitting `targetMarginPct` | 1 |
| Break-even units | fixed costs ÷ contribution | 2 |
| Margin of safety | how far price can fall | 2 |
| Margin per £ invested | contribution ÷ unit cost | 2 |
| GMROI | gross margin £ ÷ avg inventory cost | 3 |
| Blended vs incremental | with and without ad spend | 3 |

Rows 1–6 already exist in `MarginResult`.
