# DESIGN.md — visual and interaction rules

For anyone (human or agent) designing UI for CogsPilot. Read this before adding
a screen, a component or a chart.

---

## 1. What this app is for

A merchant looks at a product and needs to know, in under three seconds,
**whether they are making money on it**. Everything else is secondary.

Two audiences, one interface:

- **The beginner**, who does not know the difference between markup and margin
  and is quietly terrified of getting it wrong
- **The operator**, who has 4,000 SKUs and wants the twelve that are bleeding

Design for the beginner. The operator can cope with a simple interface; the
beginner cannot cope with a complicated one.

## 2. Voice

Plain, calm, British, never patronising. We are the accountant who explains
things without sighing.

| Don't | Do |
|---|---|
| "Negative contribution margin detected" | "You're losing £1.20 on every one of these" |
| "COGS: £45.00" | "This costs you £45 to have on the shelf" |
| "Allocate overhead by revenue basis?" | "Spread the rent across products? (Most people shouldn't yet)" |
| "Invalid input" | "That looks like a price including VAT — shall I take the VAT off?" |
| "Error: no unit cost" | "No cost recorded, so this margin is a guess" |

Spellings: customise, organise, colour, favour. Currency reads from
`ShopSettings.currencyCode` — never hardcode £.

Never say "COGS" to a user without a plain-English gloss next to it the first
time it appears on a screen.

## 3. The technical constraint that shapes everything

**The admin UI uses Polaris web components (`s-*`), not the Polaris React
package**, typed via `@shopify/polaris-types`. The product widget is Preact via
`@shopify/ui-extensions`.

This means:

- **Use Polaris primitives; do not reinvent them.** Cards, badges, banners,
  tables, form fields all exist. Custom CSS on a Polaris component is a smell.
- **Custom visuals must be inline SVG or CSS.** No charting library in the
  extension bundle — the widget loads inside a merchant's product page and
  weight is a courtesy.
- **The widget cannot compute anything.** It renders what `/api/margin` returns.
  Any design that implies live client-side recalculation needs an API round trip
  or an engine change — flag it, don't fake it.
- **Everything is inside an iframe.** Links out of the admin need
  `target="_top"`. No modals that assume full viewport height.

## 4. Colour and status

Status is semantic, driven by `MarginStatus` from the engine. Never invent a
sixth state, and never colour something red because it feels bad.

| Status | Meaning | Tone | Rule |
|---|---|---|---|
| `unknown` | no unit cost recorded | neutral / info | **Never green.** Missing data must not look like health |
| `loss` | selling below total cost | critical | The loudest thing on the screen |
| `critical` | below `criticalMarginPct` | critical | |
| `warn` | below `warnMarginPct` | warning | |
| `healthy` | at or above target | success | |

**Colour is never the only signal.** Every status carries a word or an icon —
roughly 1 in 12 men has some form of colour vision deficiency, and this is an
app about not losing money.

`unknown` deserves its own emphasis in the design: a variant with no cost is
the *most* valuable row on the dashboard, not a gap to be greyed out.

## 5. The money waterfall

The signature component. One horizontal bar representing the selling price;
each cost takes a coloured bite; what remains is profit.

```
│████████████████│██████│███│██│▓▓▓▓▓▓▓▓│
  landed cost      tax   fee  ship  PROFIT
```

Rules:

- **Segments are ordered as the engine calculates**, left to right: tax out,
  landed cost, then each applied cost in `sortOrder`, profit last.
- **Profit is the only segment that changes colour.**
- **A negative profit visibly overshoots the end of the bar**, hatched, in the
  critical tone. Losing money should *look* wrong before anyone reads a number.
- **Tap or hover a segment**: it lifts, the others dim, and it shows its amount
  and its percentage of the price.
- Animate transitions at ~200ms with spring easing. Anything slower feels
  broken; anything instant feels like a bug.
- Label segments below 6% width outside the bar or in the tooltip only —
  never squeeze 4pt text into a sliver.

## 6. Tactile controls

The app should feel like something you can *play* with, not a form you submit.

- **Every numeric input has a slider and a typed field, always both.** The
  slider is for exploring, the field is for entering a real invoice figure.
- **Slider bounds auto-set to a sensible range** for that cost type, with detents
  at meaningful points: current value, break-even, target margin.
- **Live commentary under the slider as it moves** — *"At 12% returns you're now
  losing 40p a unit."* The number is the answer; the sentence is the insight.
- **Mute toggles, not delete buttons.** Flick a cost off, watch the waterfall
  close the gap and the profit jump. Nothing is lost, and this is the single
  cheapest way to make the app feel like a toy rather than a tax return.
- **Lock and solve.** A padlock on any field. Lock cost and target margin, drag
  the margin slider, and the price solves itself. `solvePriceForMargin` already
  does this maths — the UI just has to expose it. Build it early; it is the most
  delightful thing in the app.
- **Drag to reorder, tap to add.** Drag-and-drop is lovely on desktop and
  miserable on a phone at 10pm, which is when most small sellers are working.
  Reordering is a genuine drag gesture; *adding* a cost block is a tap on a
  palette.
- Haptic tick on mobile when a value crosses break-even or the target.

## 7. Progressive disclosure

Three levels (see `docs/MARGIN-MODEL.md` §4). The level sets what is **visible
by default**, never what exists.

- Level 1 shows three inputs and one number
- Moving up a level **never re-asks anything already answered**
- Moving down **hides, never deletes**, and shows a "3 hidden costs" chip —
  nothing is silently excluded from a number a merchant is trusting

## 8. Non-negotiable UI elements

- **Markup and margin side by side, permanently.** "I add 50% so I make 50%" is
  the most expensive misunderstanding in small business (50% markup = 33%
  margin). Not a tooltip. On the screen.
- **"Explain this number."** Every headline figure expands to a plain-English,
  line-by-line walk of the maths. The engine returns every intermediate value
  precisely so this is possible.
- **Provisional-data banners stay until confirmed.** Unconfirmed tax setup, or
  a catalogue that has never synced, means every number on screen may be wrong
  by the tax rate — with no visible symptom. Say so, at the top, until it is
  resolved.
- **Contextual help lives inline, expanding in place.** Never a modal; modals
  break the flow of someone half-understanding a concept. Four fields per help
  entry: what it is, why it matters, a typical range, and where to find their
  own number (which Shopify report, which invoice line).

## 9. Empty and error states

Empty states are the best teaching moment in the app. Never a shrug.

| State | Show |
|---|---|
| No sync yet | What a sync does, how long it takes, one button |
| No costs recorded | Why margin needs a cost + the fastest way to add one |
| Every product healthy | Say so plainly, then offer the next question — margin per £ invested |
| Sync failed | What failed, whether the data on screen is stale, and how to retry |
| No subscription | What still works, not just what doesn't |

## 10. Accessibility

- Keyboard reachable end to end. Sliders respond to arrow keys, page up/down,
  home/end.
- Every slider has a paired text input, which is also the accessible fallback.
- Status conveyed by text as well as colour, always.
- Respect `prefers-reduced-motion`: transitions become instant, the waterfall
  still redraws.
- Minimum 4.5:1 contrast on text; do not rely on Polaris subdued tones for
  anything load-bearing.

## 11. Performance courtesies

- The widget renders inside a merchant's product page. Keep the bundle small;
  no chart library, no icon font, no web font.
- The products table sends at most 500 rows and filters client-side. Any design
  implying "scroll through all 4,000" needs pagination or server-side filtering
  designed in, not assumed.
- Show a skeleton, not a spinner, for anything that has a known shape.
