# App Store submission

Everything needed to take CogsPilot through Shopify App Store review: the
listing copy ready to paste, the assets still to be produced, and the review
checklist mapped to where each requirement is met in this codebase. Character
limits are Shopify's at time of writing — recheck them in the Partner
Dashboard form, which is always the authority.

---

## 1. Listing copy

**App name** (≤30 chars)

> CogsPilot

**Tagline / app card subtitle** (≤62 chars)

> The real margin on every product — landed cost, tax, fees

**App introduction** (≤100 chars)

> See what each product actually makes after freight, duty, VAT and payment
> fees — not the flattering number.

**App details** (≤500 chars)

> Most margin tools stop at (price − cost) ÷ price. On a UK store selling at
> £120 inc VAT against a £60 cost, that reports 50%; the true figure is 40%
> before you've paid a payment fee or a courier. CogsPilot closes that gap.
> Build each product's landed cost from blocks you name yourself — freight,
> duty, FX — with templates for structures you reuse. Shop-wide rules cover
> payment fees, postage and returns. A money waterfall shows where every
> penny of the price goes, and lock-and-solve prices any product from the
> margin you want.

**Feature bullets** (≤80 chars each)

1. Real net margin on the product page: landed cost, tax and fees included
2. The money waterfall — watch every cost take its bite from the price
3. Lock-and-solve: name the margin you want, the price solves itself
4. Cost blocks and reusable templates — type "Imported from EU" once
5. Honest uncertainty: guessed costs make the margin a range, not gospel
6. Dashboard finds the products losing money and the ones with no cost at all

**Search terms** (pick ≤5): `margin`, `profit`, `COGS`, `landed cost`,
`pricing`

**Category**: Store management → Finances (confirm the current taxonomy in
the form; "Analytics" is the fallback).

**Languages**: English.

**Support**: graham@loadeddice.uk · Privacy policy: `<application_url>/privacy`
(served by the app — see `app/routes/privacy.tsx`, kept truthful against
`gdpr.server.ts`).

## 2. Assets to produce

**App icon** (1200×1200, no screenshots, no wordmark-only designs): a simple
mark suggesting a price being seen through — e.g. a bold waterfall bar with
the final segment in green. Flat colour, legible at 64px, no text.

**Screenshots** (1600×900 desktop, 3–6, taken on the demo store):

| # | Scene | Caption |
|---|---|---|
| 1 | Widget on a healthy variant: badge, margin, band, waterfall | "The number Shopify doesn't show you — with every cost in it" |
| 2 | Lock-and-solve mid-flow, quote showing | "Name the margin you want. The price solves itself" |
| 3 | Cost blocks with a template being applied | "Type 'Imported from EU' once. Apply it anywhere" |
| 4 | Dashboard rollup with loss-makers surfaced | "The twelve products quietly bleeding, worst first" |
| 5 | Confidence band + tighten list | "Guessed a cost? The margin says so — honestly" |
| 6 | Settings detail levels | "As simple or as forensic as you like" |

**Demo screencast** (for the review team, ~90 seconds): install → tax
detection banner → confirm settings → open a product → enter unit cost →
add a freight block → waterfall reacts → solve for 35% → set price → dashboard
shows the rollup. No audio needed; captions fine.

## 3. Review checklist, mapped to the code

| Requirement | Where it's met |
|---|---|
| Embedded, session-token auth, immediate OAuth | `@shopify/shopify-app-react-router` managed auth; `embedded = true` in `shopify.app.toml` |
| Billing via approved method | Managed App Pricing (Shopify-hosted plan page) — `app/lib/billing.server.ts`; no Billing API calls to review |
| Mandatory compliance webhooks, HMAC-verified | `compliance_topics` in `shopify.app.toml`; handlers in `app/routes/webhooks.customers.*`, `webhooks.shop.redact.tsx`; verification via `authenticate.webhook`; purge logic + audit trail in `app/lib/gdpr.server.ts` |
| Privacy policy URL | `/privacy` (`app/routes/privacy.tsx`), public and unauthenticated |
| Minimal scopes, each justified | `shopify.app.toml` — every scope carries its reason as a comment; nothing speculative |
| App must not break with no data | Empty states are designed (DESIGN.md §9); a never-synced shop gets a working dashboard and an honest banner |
| Webhooks answer fast | `bulk_operations/finish` matches and enqueues only; ingest happens on the worker |
| No `console.*`, secrets redacted from logs | `app/lib/logger.ts`, enforced by tests |
| Performance | Admin-embedded only — no storefront script, no theme impact, so no Lighthouse hit to explain |

**Protected customer data (the one Partner Dashboard step that needs care):**
`read_orders` puts the app in the protected-customer-data flow. In the
Partner Dashboard, request access to **Orders** at the minimum level and
none of the optional PII fields (name, address, email, phone). The truthful
answers, evidenced by `app/lib/bulk.server.ts`: the only order query selects
`lineItems { quantity, variant { id } }`; one integer per variant is stored;
no customer fields are requested, stored, or logged. The data-protection
questionnaire answers (encryption in transit, at rest via the database
provider, purge on shop redaction) match `gdpr.server.ts` and the privacy
page.

## 4. Pricing

Plans live in the Partner Dashboard (managed pricing), not in code — the app
only checks for an active subscription and sends merchants to Shopify's plan
page. Recommended starting shape, matching what the code and copy assume:

- **One plan**: £19 / 30 days, **14-day free trial**, no usage charges.
- Keep it single until real merchants argue otherwise; the disclosure levels
  already serve beginners and operators inside one plan.

## 5. Submission order of operations

1. **Hosting first**: deploy the app to its production URL with Postgres and
   the worker running, set `application_url` and redirect URLs (the CLI's
   `shopify app deploy` pushes config), and confirm `/privacy` resolves.
2. Create the **demo store**, sync a small but varied catalogue (a
   loss-maker, a healthy line, a variant with no cost, one discounted).
3. Partner Dashboard: complete **protected customer data** (§3) and
   **managed pricing** (§4).
4. Fill the listing (§1), upload assets (§2), attach the screencast and a
   test-store link for the reviewer, with a two-line "how to see it work".
5. Run the automated checks on the submission page; fix anything flagged;
   submit. Review turnaround is typically days — respond to reviewer notes
   in the Partner Dashboard thread.

## 6. Pre-flight, the morning you submit

- [ ] `npm test && npm run typecheck && npm run build` green on `main`
- [ ] Production app loads inside the admin on the demo store
- [ ] Install flow from a clean store: OAuth → tax detection banner → widget
      works before any sync has run
- [ ] Sync completes on the demo store; dashboard populated; nightly sync on
- [ ] Widget save, solve and apply-price round trips work on production
- [ ] `/privacy` publicly reachable over HTTPS
- [ ] `SENTRY_DSN` set (or consciously not), logs carrying `shop`
- [ ] Uninstall/reinstall on a scratch store keeps cost data; `shop/redact`
      purge verified once against a scratch shop
