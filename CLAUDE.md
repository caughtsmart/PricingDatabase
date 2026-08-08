# CLAUDE.md — working rules for this repo

CogsPilot is a Shopify app that reports the **real** margin on every product:
landed cost, tax and payment fees included. Read `README.md` for the full
architecture. This file is the operating manual for agents working in the code.

---

## 1. The one thing that must never break

**`app/lib/margin.ts` is the single source of truth for every number the app
displays.** The widget, the dashboard, the API route and any future export all
call it. If two surfaces ever show different margins for the same variant, that
is a P1 bug and the cause is almost always someone doing arithmetic outside this
module.

Rules for that file:

- **Pure and dependency-free.** No Prisma, no `fetch`, no React, no `Date.now()`,
  no environment variables. Inputs in, numbers out.
- **Never returns `NaN` or `Infinity`.** Every division is guarded. A £0 price,
  a null cost and a −100% tax rate are all valid inputs that must produce a
  sane result.
- **Every change ships with tests.** `app/lib/margin.test.ts` includes
  round-trip checks that feed `breakEvenPrice` and `targetPrice` back through
  `calculateMargin` and assert the margin comes out at 0% and target%. Keep
  those. They catch algebra errors that eyeballing never will.
- **Money is rounded once, at the edge.** `roundMoney` / `roundPct` are applied
  when building the result object, never mid-calculation. Do not round inside
  intermediate steps.

## 2. Architecture at a glance

| Layer | Location | Notes |
|---|---|---|
| Margin engine | `app/lib/margin.ts` | Pure. Start here. |
| Config resolution | `app/lib/settings.server.ts` | Prisma `Decimal` → `number` happens here, once |
| Catalogue cache | `VariantSnapshot` (Prisma) | Dashboard reads this, **never** the Admin API live |
| Background sync | `app/lib/sync.server.ts`, `bulk.server.ts` | Bulk Operations + pg-boss |
| Scheduling | `app/lib/autosync.ts` | Prisma-free on purpose, so it is testable |
| Server routes | `app/routes/app.*.tsx` | React Router 7 loaders/actions |
| Widget | `extensions/margin-block/` | Preact, calls `app/routes/api.margin.tsx` |
| UI system | Polaris **web components** (`s-*`) | Not the React package. See `docs/DESIGN.md` |

### Boundaries that exist for a reason

- **Server-side calculation only.** The widget fetches computed numbers from
  `api.margin.tsx`; it does not import the engine. This is what stops the widget
  and the dashboard drifting apart.
- **`.server.ts` suffix is load-bearing.** Anything touching Prisma, secrets or
  the queue must be `*.server.ts` so the bundler keeps it out of the client.
- **`autosync.ts` and `onboarding.ts` have no `.server` suffix and no Prisma
  import** — deliberately. They hold scheduling and tax-detection rules that are
  invisible when wrong, so they are unit-tested directly. Do not add a database
  call to either; add it to the `.server.ts` sibling.

## 3. Conventions

- **TypeScript strict.** No `any`. No non-null `!` assertions on data crossing a
  boundary (webhook payloads, JSONL rows, API responses) — narrow it properly.
- **`console.*` is banned in app code.** Use `app/lib/logger.ts`. It redacts
  secrets by field name *and* by value shape, unconditionally. Never bypass it,
  and never add a "just this once" `console.log` — the redaction is the point.
- **Every log line carries `shop`.** A report you cannot trace to a merchant is
  not much use at 3am.
- **Money in Postgres is `Decimal`, money in the engine is `number`.** Convert
  exactly once, in `settings.server.ts`. Do not scatter `.toNumber()` through
  routes or components.
- **Comments explain *why*, not *what*.** This codebase already does this well —
  match the existing tone. If a decision looks odd, the comment says which wrong
  alternative was rejected and why.
- **British English** in all user-facing copy: "customise", "organise",
  "colour". Currency defaults to GBP but must never be hardcoded — read
  `ShopSettings.currencyCode`.

## 4. Things that will bite you

- **pg-boss cannot share Prisma's connection pool.** The `fromPrisma` adapter
  fails: pg-boss selects a `regclass` column and Prisma's raw-query deserializer
  rejects the type (P2010), so `boss.start()` throws. Verified against pg-boss
  12.27 / Prisma 6.19. Keep the dedicated pool (`QUEUE_POOL_SIZE`, default 2)
  and keep it small — managed Postgres connection limits are the first ceiling
  a Shopify app hits.
- **Queue names are `cogspilot.sync` / `cogspilot.nightly`.** Renaming them
  orphans any jobs already queued under the old name. If you rename, drain first.
- **Only one bulk *query* per shop at a time.** Catalogue and orders run in
  sequence, not in parallel. Do not "optimise" this.
- **Ingest is stamp-and-sweep, not wipe-and-replace.** Rows are stamped with
  `lastSeenSyncId`; stale rows are deleted at the end. Never introduce a
  "delete all then insert" path — the dashboard would show a half-empty
  catalogue mid-sync.
- **Webhooks must return fast.** `bulk_operations/finish` matches the operation
  to its run and enqueues, nothing more. A slow webhook gets retried, and
  retries mean concurrent ingests racing.
- **A sales-stage failure must not fail the run.** The catalogue is already in
  by then. Complete with a note.
- **Tax detection never overwrites a confirmed setting.** `afterAuth` fires on
  every reauth, not just first install.
- **An unknown country yields a 0% tax rate, not a guess.** Zero is wrong in an
  obvious direction (margins look too good) and the banner says so. A plausible
  invented rate would be wrong and invisible.

## 5. Commands

```bash
npm run dev         # Shopify CLI dev, tunnel + HMR
npm test            # vitest — engine, sync, autosync, billing, logger
npm run typecheck   # app AND extension
npm run build       # production build (also bundles the worker)
npm run worker      # run the worker separately; needs a build first
npm run deploy      # push app config + extensions to Shopify
```

**Before opening a PR:** `npm test && npm run typecheck && npm run build`.
CI additionally boots the built worker, because typecheck and bundle both pass
on a module graph Node itself cannot resolve — only running it catches that.

## 6. Definition of done

- [ ] Tests pass, typecheck passes, build passes
- [ ] New engine behaviour has a unit test, including an edge case at 0 and null
- [ ] No `console.*`, no `any`, no secrets in logs
- [ ] User-facing copy is plain English — no "COGS", "amortised" or "allocation
      basis" without a one-line explanation next to it
- [ ] Currency and tax read from settings, never hardcoded
- [ ] `README.md` updated if behaviour or setup changed

## 7. Where the product is going

`docs/MARGIN-MODEL.md` holds the target cost model: cost **blocks** instead of
fixed columns, and the migration path from the original schema. All four steps
are done — `CostRuleKind` has all six kinds, the solver is the generalised
closed form, and variant costs are `CostComponent` rows resolved by
`app/lib/components.ts` (pure, like the engine — the tree rules and cycle
guard are unit-tested there). Read it before touching `CostComponent`,
`CostRule` or `solvePriceForMargin`. The §4 disclosure levels are also in:
`app/lib/disclosure.ts` (pure again) resolves a shop's level into view flags
the widget renders — levels hide working, never money, and the monotonicity
test enforces "moving up never hides". §2.5 confidence is in too:
`app/lib/confidence.ts` (pure) turns each block's KNOWN/ESTIMATED/GUESSED tag
into the headline's "likely X–Y%" band and the ranked "tighten this up" list.
Still open, per the doc: per-component `base` overrides and product/template
scope.

`docs/DESIGN.md` holds the visual and interaction rules. Read it before adding
any UI.
