# CogsPilot

A Shopify app that shows the **real** margin on every product — landed cost,
tax, and payment fees included — as a widget on the product details page in the
admin, plus a dashboard that rolls it all up.

Most margin tools compute `(price − cost) / price`. On a UK store selling at
£120 inc VAT against a £60 cost, that reports **50%**. The actual figure is
**40%** before you have paid a payment fee or a courier. CogsPilot exists to
close that gap.

---

## Documentation

| File | For |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Working rules for agents and contributors: invariants, conventions, traps |
| [`docs/MARGIN-MODEL.md`](docs/MARGIN-MODEL.md) | The cost model, where it is going, and the migration path |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Voice, colour, the money waterfall, tactile controls, accessibility |

---

## What it does

**On the product page** (admin UI extension, `admin.product-details.block.render`)

- Net margin, profit per unit and a health badge for the selected variant
- The money waterfall: the price as one bar, each cost taking its bite,
  profit last — tap a segment to inspect it
- A full walk from price → tax → landed cost → fees → net profit
- Break-even price, and the price needed to hit your target margin
- Lock-and-solve: hold the costs still, name a margin, and the price solves
  itself — one confirmed tap then sets it on the variant
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
variable cost = net revenue × Σ(% of revenue)
              + landed cost × Σ(% of cost + loss rates)
              + Σ(fixed per unit)
              + Σ(fixed per order ÷ average basket)
              + Σ(per day held × days of cover)
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
limit. The cache is filled by the background sync below, and kept current
between syncs by `products/update` and `products/delete` webhooks.

## Background sync

Syncing runs on Shopify's **Bulk Operations API** and a Postgres-backed job
queue, so clicking **Sync catalogue** returns immediately no matter how large
the store is.

```
startSync()   submits the catalogue bulk query, returns at once
Shopify       runs it, then sends bulk_operations/finish
webhook       matches it to the run and queues an ingest job
worker        streams the JSONL in, upserts, submits the orders query
webhook       fires again; the worker ingests sales and finalises the run
```

Catalogue and sales run in sequence rather than together because Shopify permits
only one bulk *query* per shop at a time. The dashboard polls while a run is in
flight and stops as soon as it is not.

Three details worth knowing if you touch this code:

- **Ingest is a stamp-and-sweep, not a wipe-and-replace.** A streamed import
  cannot wrap "delete everything, insert everything" in one transaction without
  holding the whole catalogue in memory. Each row is stamped with the
  `lastSeenSyncId` that wrote it, and rows still carrying an older stamp are
  deleted at the end — so the dashboard never shows a half-empty catalogue, and
  products deleted in Shopify still disappear.
- **The webhook does almost nothing.** It matches the operation to its run and
  enqueues. A webhook that takes minutes gets retried, which would mean several
  ingests racing each other.
- **A failure in the sales stage does not fail the run.** The catalogue is
  already in by then; losing correct product margins because sales history
  stumbled would be the wrong trade. The run completes with a note instead.

### Nightly automatic sync

Merchants do not have to press the button. A pg-boss cron job ticks **hourly**,
and each shop is assigned a fixed hour derived from a hash of its own domain —
so a few hundred installs spread evenly across the day instead of every sync
firing at 03:00 and stampeding both Shopify's bulk queue and our database.

The assignment is deterministic and stable: a shop lands on the same hour
tomorrow as it did today. Nothing is stored for it, and there is no per-shop
schedule to create on install or tear down on uninstall.

A shop is skipped when it has opted out, already has a sync in flight, is not
due this hour, or synced within the last 20 hours. That last guard matters — the
hourly tick can fire twice for the same hour after a retry or a restart, and
without it a shop would start a second sync on top of the first.

Shops are enumerated from the `Session` table, so uninstalling drops a shop out
automatically. A shop that fails — usually a revoked token — is logged and
skipped rather than aborting the tick for everyone else that hour.

Merchants can turn it off under **Settings → Automatic sync**, which also shows
the hour their shop is assigned. The scheduling rules live in
[`app/lib/autosync.ts`](app/lib/autosync.ts), kept free of Prisma so they can be
tested directly: a bug there is invisible until it either hammers Shopify or
quietly stops syncing everyone.

The queue is [pg-boss](https://github.com/timgit/pg-boss), chosen to avoid
adding Redis. Jobs are durable, retried with backoff, and locked in Postgres, so
several web instances running the in-process worker is safe.

It opens a small dedicated connection pool (`QUEUE_POOL_SIZE`, default 2).
pg-boss ships a `fromPrisma` adapter that would let it share Prisma's pool, and
that was tried first — it does not work: pg-boss's internal SQL selects a
`regclass` column and Prisma's raw-query deserializer rejects that type outright
(P2010), so `boss.start()` throws. Verified against pg-boss 12.27 and Prisma
6.19. Keep the pool small; managed Postgres connection limits are usually the
first ceiling a Shopify app meets.

The queue starts when the server boots (not on first use), because the hourly
schedule has to be running even on a day nobody opens the app.

Run the worker separately once ingestion starts competing with request latency:

```bash
# web
RUN_WORKER_IN_PROCESS=false npm start
# worker (needs `npm run build` first — see below)
npm run worker
```

The worker is bundled by `npm run build` into `build/worker/worker.js` and run
as plain JavaScript. It shares its module graph with the app, which Node's
type-stripping resolver cannot walk without an explicit `.ts` on every internal
import — bundling keeps the source clean and puts no TypeScript toolchain in
production. CI boots the built worker on every run, because typechecking and
bundling both pass on a graph Node itself cannot resolve; only running it
catches that.

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
docker run --name cogspilot-db -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=cogspilot -p 5432:5432 -d postgres:16
# DATABASE_URL="postgresql://postgres:postgres@localhost:5432/cogspilot?schema=public"
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

## Error monitoring

Most of this app's failures happen where nobody is watching. The catalogue sync
runs from a webhook and a job queue, so a merchant's 03:00 sync can fail with no
one on the other end of a request. Errors therefore have to be findable after
the fact.

- **Structured logging.** JSON lines in production, readable text elsewhere.
  Every line carries the shop it belongs to, so a report can be traced back to a
  merchant. `console.*` is not used anywhere in app code.
- **Secrets are redacted before anything is written.** Both by field name
  (`accessToken`, `authorization`, anything matching `secret`/`token`) and by
  value shape — Shopify's `shpat_`/`shpca_`/`shppa_`/`shpss_` prefixes and
  anything shaped like a JWT. This matters because `logger.error("auth failed",
  { session })` is the line anyone would naturally write, and an offline token
  is a long-lived credential for a merchant's entire store. Redaction is applied
  unconditionally rather than left to the caller to remember, and it survives
  circular references so a log call cannot hang the process.
- **Sentry, optional.** Set `SENTRY_DSN` and errors are reported there as well;
  leave it unset and the app runs identically on logs alone. It sits behind an
  `ErrorReporter` interface so the vendor is swappable, and `beforeSend` re-runs
  the app's own redaction over the outgoing event — the SDK attaches its own
  context, so redacting only at the call site would leave a path for a token to
  reach a third party.
- **Process-level handlers** for `unhandledRejection` and `uncaughtException`.
  Without these a rejected promise inside a queue handler is a silent no-op. An
  uncaught exception exits deliberately so the platform restarts a clean
  process, which is Node's own default and exists for good reason.

Sync failures are logged as well as written to `SyncRun.errorMessage`: that
column is only visible to a merchant who happens to open the dashboard, which is
not the same as reaching whoever operates the app.

One Sentry caveat: its Node SDK prefers being initialised before the modules it
instruments, via `--import ./instrument.mjs`. Loading it from
`monitoring.server.ts` means automatic HTTP/database tracing may be incomplete.
Explicit error reporting — what this app relies on — works fine. Add the
`--import` hook if you later want tracing too.

## Tax detection at install

Getting tax wrong is the most consequential thing this app can do quietly. The
engine divides tax out of tax-inclusive prices, so the wrong setting shifts
*every* margin in the shop by the tax rate — with no visible symptom. A UK store
left on the wrong setting reports 50% where the truth is 40%.

So the `afterAuth` hook detects the setup on install, and the two halves are
treated with very different confidence:

| | Source | Confidence |
|---|---|---|
| Do prices include tax? | `shop.taxesIncluded` | Authoritative — never ask |
| What is the rate? | Inferred from the shop's country | A suggestion to confirm |

Shopify has no single "the tax rate" to read: tax is modelled as per-region
rules that vary by product and destination. So the rate comes from a small
country table in [`app/lib/onboarding.ts`](app/lib/onboarding.ts), which is a
**starting point for the merchant to confirm, not a tax lookup**.

Three deliberate choices:

- **An unknown country yields 0, not a guess.** Zero is wrong in an obvious
  direction — margins look too good — and the banner says exactly that.
  Inventing a plausible rate would be wrong and invisible.
- **When prices exclude tax the rate is forced to 0**, not stored. It has no
  effect on margin in that mode, and a stashed rate would be a trap for whoever
  later flips the tax-inclusive switch.
- **Detection never overwrites a confirmed setting.** `afterAuth` fires on every
  reauth, not just first install, so reinstalling must not reset a rate the
  merchant deliberately changed.

Until the merchant confirms, the dashboard leads with a banner saying margins
are provisional. Confirming is one click, and saving the tax form counts as
confirmation — no need to click twice. A failed detection degrades to "ask the
human" rather than to bad data, and can never break the OAuth callback.

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

- **The products table sends at most 500 rows** to the browser and filters
  client-side.
- **Realised margin covers a fixed 90-day window.** Not yet configurable.
- **Costs are current, not historical.** Realised profit uses today's costs
  against past unit sales, so it is a good approximation rather than true
  period-accurate COGS. Cost snapshotting at order time is the fix.
- **Multi-currency is not handled.** Everything assumes the shop's base
  currency.

## Before submitting to the App Store

Done:

- ✅ **Billing** — Shopify App Pricing, enforcement behind a flag
- ✅ **GDPR webhooks** — all three mandatory topics, with an audit trail

- ✅ **Background sync** — bulk operations plus a job queue, no catalogue cap
- ✅ **Nightly automatic sync** — load-spread across the day, with an opt-out
- ✅ **Install-time tax detection** — with a confirmation step

- ✅ **Error monitoring** — structured logs with redaction, optional Sentry

Still to do:

1. **Configure the actual plans** in the Partner Dashboard, then set
   `BILLING_ENFORCED=true` (see [Billing](#billing))
2. App listing assets, privacy policy, and a demo store
