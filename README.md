# Margin Lens

A Shopify app that shows the **real** margin on every product — landed cost,
tax, and payment fees included — as a widget on the product details page in the
admin, plus a dashboard that rolls it all up.

Most margin tools compute `(price − cost) / price`. On a UK store selling at
£120 inc VAT against a £60 cost, that reports **50%**. The actual figure is
**40%** before you have paid a payment fee or a courier. Margin Lens exists to
close that gap.

---

## What it does

**On the product page** (admin UI extension, `admin.product-details.block.render`)

- Net margin, profit per unit and a health badge for the selected variant
- A full walk from price → tax → landed cost → fees → net profit
- Break-even price, and the price needed to hit your target margin
- Editable cost fields: unit cost (written back to Shopify's own "Cost per
  item"), plus freight, duty, packaging, handling and other

**In the app** (App Home)

- Revenue-weighted average net margin across the catalogue
- Profit sitting in current stock, and realised profit over the last 90 days
- The variants losing money or closest to it, worst first
- A per-vendor breakdown
- The variants with no cost recorded at all — usually the most valuable list
- Shop-wide cost rules and margin thresholds

## How margin is calculated

```
net revenue   = price ÷ (1 + tax rate)        # when prices include tax
landed cost   = Shopify unit cost + freight + duty + packaging + handling + other
variable cost = net revenue × Σ(% rules) + Σ(fixed-per-unit rules)
net profit    = net revenue − landed cost − variable cost
net margin    = net profit ÷ net revenue
```

Two deliberate choices worth knowing about:

- **Variants with no unit cost are counted but excluded from the average.**
  Including them would silently report a 100% margin on anything uncosted and
  flatter the headline number.
- **The catalogue average is weighted by revenue, not a plain mean.** A £2
  keyring at 70% should not cancel out a £400 boxed set at 4%.

The whole engine lives in [`app/lib/margin.ts`](app/lib/margin.ts) — pure,
dependency-free, and covered by 25 unit tests including round-trip checks that
feed the break-even and target prices back through the calculator. It runs
server-side only, so the widget and the dashboard cannot drift apart.

## Architecture

| Piece | Where | Notes |
|---|---|---|
| App server | React Router 7 + `@shopify/shopify-app-react-router` | Shopify's currently recommended template |
| UI | Polaris **web components** (`s-*`) | Typed via `@shopify/polaris-types` |
| Widget | Preact + `@shopify/ui-extensions` | The current admin extension model |
| Database | Postgres via Prisma | SQLite is not used; see below |
| Admin API | GraphQL, `2026-07` | Every query validated against the schema |

The dashboard reads a local `VariantSnapshot` cache rather than the Admin API —
paging a whole catalogue on each page load would be slow and would burn the rate
limit. The cache is refreshed by the **Sync catalogue** button and kept current
between syncs by `products/update` and `products/delete` webhooks.

## Getting started

Requires Node 20.10+, a Shopify Partner account, and a Postgres database.

```bash
npm install
cp .env.example .env          # then fill in DATABASE_URL
npx prisma migrate deploy
npm run dev                   # shopify app dev
```

A local Postgres for development:

```bash
docker run --name marginlens-db -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=marginlens -p 5432:5432 -d postgres:16
# DATABASE_URL="postgresql://postgres:postgres@localhost:5432/marginlens?schema=public"
```

Then in the admin: open the app, hit **Sync catalogue**, and add the **Margin**
block to a product page via *Add app block* (the widget appears in the product
details sidebar).

### Commands

```bash
npm run dev         # Shopify CLI dev with tunnel + HMR
npm test            # margin engine unit tests
npm run typecheck   # app and extension
npm run build       # production build
npm run deploy      # push app config + extensions to Shopify
```

## Billing

Uses **Shopify App Pricing** (what used to be called Managed Pricing). Plans are
defined in the Partner Dashboard app listing, not in code — Shopify hosts the
plan selection page and handles charges, trials, proration and price changes.
There is deliberately no `billing` block in `shopify.server.ts`: mixing App
Pricing with the Billing API is not supported.

The app does two things (`app/lib/billing.server.ts`):

1. **Checks the current shop's subscription** via
   `currentAppInstallation.activeSubscriptions` on the Admin API. Shopify's docs
   point at the Partner API's Active Subscription endpoint, but that needs an
   organisation-level token an embedded per-shop request does not have. The
   Admin API answers the same question for the shop in front of us using the
   session we already hold. Reach for the Partner API when you need state that
   survives uninstall, or a billing event history.
2. **Links to the hosted plan page** at
   `https://admin.shopify.com/store/{store}/charges/{app-handle}/pricing_plans`,
   always with `target="_top"` — the app is in an iframe and cannot navigate the
   admin's parent window otherwise.

### Turning enforcement on

Enforcement is **off by default**, controlled by `BILLING_ENFORCED=true`. This
is deliberate: plans live in the Partner Dashboard, so enforcing before they
exist would redirect merchants — and you, in development — to an empty plan
page. The order is:

1. Set up plans in Partner Dashboard → Distribution → Manage listing → Pricing
2. Verify the plan page loads from the **See plans** link in Settings
3. Set `BILLING_ENFORCED=true`

While it is off, unsubscribed merchants get a dismissable prompt on the
dashboard and full access. With it on, the check in `app/routes/app.tsx` gates
every page beneath the layout.

Subscription status is read once per navigation in the `app` layout loader and
shared with child routes via `useRouteLoaderData`, so a page load costs one
billing query, not three. If that ever shows up in latency, cache it per shop
with a short TTL.

## Privacy and GDPR

The three mandatory compliance webhooks are implemented and wired up in
`shopify.app.toml` (note they use `compliance_topics`, not `topics`).

**This app stores no customer personal data.** That is not a convenient
assertion — it falls out of the design. The sales query behind realised margin
selects only `lineItems { quantity, variant { id } }`; no customer, name, email
or address field is ever requested, and `VariantSnapshot` keeps a single integer
per variant. `Session` holds merchant *staff* details for online sessions, which
is staff data, not customer data.

| Topic | What happens |
|---|---|
| `customers/data_request` | Logged and closed — nothing to disclose |
| `customers/redact` | Logged and closed — nothing to erase |
| `shop/redact` | Purges every row for that shop, in one transaction |

Each request is recorded in a `ComplianceRequest` row with what was done about
it, so the "we hold nothing" answer can be evidenced during App Review rather
than merely claimed. Those rows deliberately store only Shopify's own
identifiers — never the name, email or phone that arrives in the payload.

Note the split between uninstall and redaction: `app/uninstalled` keeps the
merchant's cost data in case they reinstall, because re-entering every landed
cost would be punishing. `shop/redact` arrives 48 hours later if the data really
must go, and deletes everything.

## Scopes

| Scope | Why |
|---|---|
| `read_products` | Prices, titles, variants |
| `write_products` | Reserved for writing cost metafields |
| `read_inventory` | `InventoryItem.unitCost` — Shopify's cost per item |
| `write_inventory` | Let merchants correct unit cost from the widget |
| `read_orders` | Realised margin over the trailing 90 days |

## Known limits

These are deliberate v1 boundaries, not oversights:

- **Catalogue sync caps at 20,000 variants** (200 pages × 100). Beyond that the
  UI says so explicitly rather than silently truncating; the fix is the Bulk
  Operations API.
- **Realised margin scans up to 5,000 recent orders** (100 pages × 50) over a
  90-day window.
- **Sync is synchronous**, driven by a button. A large catalogue will hold the
  request open. A background job queue is the natural next step.
- **The products table sends at most 500 rows** to the browser and filters
  client-side.
- **Costs are current, not historical.** Realised profit uses today's costs
  against past unit sales, so it is a good approximation rather than true
  period-accurate COGS. Cost snapshotting at order time is the fix.
- **Multi-currency is not handled.** Everything assumes the shop's base
  currency.

## Before submitting to the App Store

Done:

- ✅ **Billing** — Shopify App Pricing, enforcement behind a flag
- ✅ **GDPR webhooks** — all three mandatory topics, with an audit trail

Still to do, in rough priority order:

1. **Configure the actual plans** in the Partner Dashboard, then set
   `BILLING_ENFORCED=true` (see [Billing](#billing))
2. Move sync to a background job so large stores do not time out
3. Onboarding: detect `shop.taxesIncluded` on install and pre-fill the tax
   setting instead of defaulting to UK VAT
4. App listing assets, privacy policy, and a demo store
5. Error monitoring and structured logging
