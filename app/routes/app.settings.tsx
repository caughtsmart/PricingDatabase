import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteLoaderData,
} from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import type { loader as appLoader } from "./app";

import { formatSyncHour } from "../lib/autosync";
import { clampLevel, LEVEL_OPTIONS } from "../lib/disclosure";
import { formatMoney, formatPercent, parseNumber } from "../lib/format";
import { markOnboarded } from "../lib/onboarding.server";
import type { CostRuleKind } from "../lib/margin";
import {
  deleteCostRule,
  getShopConfig,
  updateShopSettings,
  upsertCostRule,
} from "../lib/settings.server";
import {
  deleteTemplate,
  listTemplates,
  renameTemplate,
  sanitiseTemplateName,
} from "../lib/templates.server";
import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const [config, templates] = await Promise.all([
    getShopConfig(session.shop),
    listTemplates(session.shop),
  ]);

  // Subscription state comes from the parent `app` route's loader — no need to
  // ask Shopify twice on one page load.
  return {
    settings: config.settings,
    rules: config.rules,
    currencyCode: config.currencyCode,
    autoSyncEnabled: config.autoSyncEnabled,
    avgUnitsPerOrder: config.avgUnitsPerOrder,
    disclosureLevel: config.disclosureLevel,
    templates,
    syncHour: formatSyncHour(session.shop),
    detectedCountryCode: config.detectedCountryCode,
    needsRateConfirmation: config.needsRateConfirmation,
  };
}

/**
 * The rule kinds a merchant can pick, with their bases said out loud.
 *
 * MARGIN-MODEL.md §2.3: a percentage is meaningless until it declares what it
 * is a percentage *of*, so the base lives in the label — never in an
 * assumption the merchant cannot see.
 */
export const COST_KIND_OPTIONS: Array<{
  kind: CostRuleKind;
  label: string;
  hint: string;
}> = [
  {
    kind: "PERCENT_OF_REVENUE",
    label: "% of revenue (after tax)",
    hint: "Payment fees, marketplace commission",
  },
  {
    kind: "FIXED_PER_UNIT",
    label: "Fixed amount per unit",
    hint: "Pick and pack, retail packaging",
  },
  {
    kind: "PERCENT_OF_COST",
    label: "% of landed cost",
    hint: "Import duty, supplier surcharge",
  },
  {
    kind: "FIXED_PER_ORDER",
    label: "Fixed amount per order",
    hint: "Courier label, box — spread across your average basket",
  },
  {
    kind: "RATE_TIMES_COST",
    label: "Loss rate (% of units written off)",
    hint: "Returns you cannot resell, breakage, theft",
  },
  {
    kind: "PER_DAY_HELD",
    label: "Amount per unit per day in stock",
    hint: "Storage, money tied up — uses each product's stock and sales speed",
  },
];

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "settings") {
    const taxRatePct = parseNumber(formData.get("taxRatePct"));
    const targetMarginPct = parseNumber(formData.get("targetMarginPct"));
    const warnMarginPct = parseNumber(formData.get("warnMarginPct"));
    const criticalMarginPct = parseNumber(formData.get("criticalMarginPct"));

    // Thresholds that cross over would make the badges nonsense, so reject the
    // save rather than storing a state the merchant cannot interpret.
    if (criticalMarginPct > warnMarginPct) {
      return {
        ok: false,
        message: "The critical threshold must be at or below the warning threshold.",
      };
    }
    if (warnMarginPct > targetMarginPct) {
      return {
        ok: false,
        message: "The warning threshold must be at or below the target margin.",
      };
    }
    if (taxRatePct < 0 || taxRatePct >= 100) {
      return { ok: false, message: "Tax rate must be between 0 and 100." };
    }

    await updateShopSettings(session.shop, {
      pricesIncludeTax: formData.get("pricesIncludeTax") === "on",
      taxRatePct,
      targetMarginPct,
      warnMarginPct,
      criticalMarginPct,
    });
    // Reviewing and saving this form is exactly the confirmation the onboarding
    // banner is asking for, so there is no need to make them click twice.
    await markOnboarded(session.shop);
    return { ok: true, message: "Settings saved." };
  }

  if (intent === "disclosure") {
    // clampLevel degrades junk to level 1 rather than rejecting: the worst
    // outcome of a mangled form post is a simpler view, never an error.
    await updateShopSettings(session.shop, {
      disclosureLevel: clampLevel(formData.get("disclosureLevel")),
    });
    return { ok: true, message: "Detail level saved." };
  }

  if (intent === "auto-sync") {
    await updateShopSettings(session.shop, {
      autoSyncEnabled: formData.get("autoSyncEnabled") === "on",
    });
    return { ok: true, message: "Sync schedule updated." };
  }

  if (intent === "basket") {
    const avgUnitsPerOrder = parseNumber(formData.get("avgUnitsPerOrder"));
    if (avgUnitsPerOrder < 1) {
      return {
        ok: false,
        message: "An order always has at least one item, so use 1 or more.",
      };
    }
    await updateShopSettings(session.shop, { avgUnitsPerOrder });
    return { ok: true, message: "Basket size saved." };
  }

  if (intent === "rule") {
    const name = String(formData.get("name") ?? "").trim();
    if (!name) return { ok: false, message: "Give the cost rule a name." };

    const kind = String(formData.get("kind")) as CostRuleKind;
    if (!COST_KIND_OPTIONS.some((option) => option.kind === kind)) {
      return { ok: false, message: "Unknown cost rule type." };
    }

    const value = parseNumber(formData.get("value"));
    if (value < 0) return { ok: false, message: "Cost rules cannot be negative." };
    if (kind === "PERCENT_OF_REVENUE" && value >= 100) {
      return {
        ok: false,
        message: "A percentage rule of 100% or more leaves nothing to sell.",
      };
    }
    if (kind === "RATE_TIMES_COST" && value > 100) {
      return {
        ok: false,
        message:
          "A loss rate is the share of units written off, so it cannot be over 100%.",
      };
    }

    const id = String(formData.get("id") ?? "") || undefined;
    await upsertCostRule(session.shop, {
      id,
      name,
      kind,
      value,
      enabled: formData.get("enabled") === "on",
    });
    return { ok: true, message: id ? "Rule updated." : "Rule added." };
  }

  if (intent === "delete-rule") {
    await deleteCostRule(session.shop, String(formData.get("id")));
    return { ok: true, message: "Rule deleted." };
  }

  if (intent === "template-rename") {
    const name = sanitiseTemplateName(formData.get("name"));
    if (!name) return { ok: false, message: "Give the template a name." };
    const renamed = await renameTemplate(
      session.shop,
      String(formData.get("id")),
      name,
    );
    return renamed
      ? { ok: true, message: "Template renamed." }
      : { ok: false, message: "You already have a template with that name." };
  }

  if (intent === "template-delete") {
    await deleteTemplate(session.shop, String(formData.get("id")));
    // Products that used the template keep their blocks: applying copies,
    // so deleting the source never re-prices anything.
    return { ok: true, message: "Template deleted." };
  }

  return { ok: false, message: "Unknown action." };
}

export default function Settings() {
  const {
    settings,
    rules,
    currencyCode,
    autoSyncEnabled,
    avgUnitsPerOrder,
    disclosureLevel,
    templates,
    syncHour,
    detectedCountryCode,
    needsRateConfirmation,
  } = useLoaderData<typeof loader>();
  const app = useRouteLoaderData<typeof appLoader>("routes/app");
  const subscription = app?.subscription;
  const planUrl = app?.planUrl;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  return (
    <s-page heading="Settings">
      {actionData ? (
        <s-section>
          <s-banner tone={actionData.ok ? "success" : "critical"}>
            <s-paragraph>{actionData.message}</s-paragraph>
          </s-banner>
        </s-section>
      ) : null}

      {subscription && planUrl ? (
        <s-section heading="Plan">
          <s-stack direction="block" gap="small-400">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge tone={subscription.active ? "success" : "neutral"}>
                {subscription.active
                  ? (subscription.planName ?? "Subscribed")
                  : "Free"}
              </s-badge>
              {subscription.price ? (
                <s-text color="subdued">
                  {subscription.price.amount} {subscription.price.currencyCode} per{" "}
                  {subscription.price.interval === "ANNUAL" ? "year" : "30 days"}
                </s-text>
              ) : null}
              {subscription.test ? <s-badge tone="warning">Test</s-badge> : null}
            </s-stack>
            {subscription.currentPeriodEnd ? (
              <s-text color="subdued">
                Renews{" "}
                {new Date(subscription.currentPeriodEnd).toLocaleDateString(
                  "en-GB",
                )}
              </s-text>
            ) : null}
            {/* target="_top" breaks out of the app iframe into the admin. */}
            <s-link href={planUrl} target="_top">
              {subscription.active ? "Change plan" : "See plans"}
            </s-link>
          </s-stack>
        </s-section>
      ) : null}

      <s-section heading="How much detail on the product page">
        <s-paragraph>
          Pick how much of the working the margin widget shows. Every level
          uses <s-text type="strong">all</s-text> of your costs in the numbers
          — a simpler view hides detail, never money.
        </s-paragraph>
        <Form method="post">
          <input type="hidden" name="intent" value="disclosure" />
          <s-stack direction="block" gap="base">
            <s-select
              name="disclosureLevel"
              label="Detail level"
              value={String(disclosureLevel)}
            >
              {LEVEL_OPTIONS.map((option) => (
                <s-option key={option.level} value={String(option.level)}>
                  {option.label}
                </s-option>
              ))}
            </s-select>
            <s-stack direction="block" gap="small-500">
              {LEVEL_OPTIONS.map((option) => (
                <s-text key={option.level} color="subdued">
                  <s-text type="strong">{option.label}</s-text> —{" "}
                  {option.description}
                </s-text>
              ))}
            </s-stack>
            <s-button type="submit" disabled={busy}>
              Save detail level
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Automatic sync">
        <Form method="post">
          <input type="hidden" name="intent" value="auto-sync" />
          <s-stack direction="block" gap="base">
            <s-checkbox
              name="autoSyncEnabled"
              label="Sync my catalogue automatically each day"
              details={`Runs at about ${syncHour}. The time is fixed per shop so that syncs are spread out rather than all firing at once. You can still sync manually at any point.`}
              defaultChecked={autoSyncEnabled}
            />
            <s-button type="submit" disabled={busy}>
              Save schedule
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Tax and targets">
        <Form method="post">
          <input type="hidden" name="intent" value="settings" />
          <s-stack direction="block" gap="base">
            <s-checkbox
              name="pricesIncludeTax"
              label="My prices include tax"
              details="Turn this on if the price on a product page is what the customer pays including VAT. Margins are then calculated on the revenue you keep, not the gross price."
              defaultChecked={settings.pricesIncludeTax}
            />
            <s-number-field
              name="taxRatePct"
              label="Tax rate"
              suffix="%"
              min={0}
              max={99}
              step={0.1}
              details={
                needsRateConfirmation
                  ? "We could not work out your rate automatically. Until you set it, margins are calculated on the full price and will look better than they are."
                  : detectedCountryCode
                    ? `Suggested from your store's country (${detectedCountryCode}). Change it if you use a different rate.`
                    : undefined
              }
              defaultValue={String(settings.taxRatePct)}
            />
            <s-number-field
              name="targetMarginPct"
              label="Target net margin"
              suffix="%"
              min={0}
              max={99}
              step={0.5}
              details="Used to suggest a price on the product page widget."
              defaultValue={String(settings.targetMarginPct)}
            />
            <s-number-field
              name="warnMarginPct"
              label="Warn below"
              suffix="%"
              min={0}
              max={99}
              step={0.5}
              defaultValue={String(settings.warnMarginPct)}
            />
            <s-number-field
              name="criticalMarginPct"
              label="Critical below"
              suffix="%"
              min={0}
              max={99}
              step={0.5}
              defaultValue={String(settings.criticalMarginPct)}
            />
            <s-button variant="primary" type="submit" disabled={busy}>
              Save settings
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Shop-wide cost rules">
        <s-paragraph>
          These apply to every sale on top of each product&rsquo;s landed cost —
          payment fees, duty, postage, returns. Every type says what its number
          is measured against, because &ldquo;3%&rdquo; means very different
          money depending on whether it is 3% of the price or 3% of the cost.
        </s-paragraph>

        <s-box padding="base" borderWidth="base" borderRadius="base">
          <Form method="post">
            <input type="hidden" name="intent" value="basket" />
            <s-stack direction="inline" gap="base" alignItems="end">
              <s-number-field
                name="avgUnitsPerOrder"
                label="Average items per order"
                min={1}
                step={0.1}
                details="Per-order costs such as postage are split across this many items. Your orders page shows the true figure."
                defaultValue={String(avgUnitsPerOrder)}
              />
              <s-button type="submit" disabled={busy}>
                Save
              </s-button>
            </s-stack>
          </Form>
        </s-box>

        {rules.map((rule) => (
          <s-box
            key={rule.id}
            padding="base"
            borderWidth="base"
            borderRadius="base"
          >
            <Form method="post">
              <input type="hidden" name="intent" value="rule" />
              <input type="hidden" name="id" value={rule.id} />
              <s-stack direction="inline" gap="base" alignItems="end">
                <s-text-field name="name" label="Name" defaultValue={rule.name} />
                <s-select name="kind" label="Type" value={rule.kind}>
                  {COST_KIND_OPTIONS.map((option) => (
                    <s-option key={option.kind} value={option.kind}>
                      {option.label}
                    </s-option>
                  ))}
                </s-select>
                <s-number-field
                  name="value"
                  label="Value"
                  min={0}
                  step={0.01}
                  defaultValue={String(rule.value)}
                />
                <s-checkbox
                  name="enabled"
                  label="Enabled"
                  defaultChecked={rule.enabled}
                />
                <s-button type="submit" disabled={busy}>
                  Save
                </s-button>
              </s-stack>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="delete-rule" />
              <input type="hidden" name="id" value={rule.id} />
              <s-button variant="tertiary" tone="critical" type="submit">
                Delete
              </s-button>
            </Form>
          </s-box>
        ))}

        <s-box padding="base" borderWidth="base" borderRadius="base">
          <Form method="post">
            <input type="hidden" name="intent" value="rule" />
            <s-stack direction="inline" gap="base" alignItems="end">
              <s-text-field name="name" label="Name" placeholder="Channel fee" />
              <s-select name="kind" label="Type" value="PERCENT_OF_REVENUE">
                {COST_KIND_OPTIONS.map((option) => (
                  <s-option key={option.kind} value={option.kind}>
                    {option.label}
                  </s-option>
                ))}
              </s-select>
              <s-number-field name="value" label="Value" min={0} step={0.01} />
              <s-checkbox name="enabled" label="Enabled" defaultChecked />
              <s-button variant="primary" type="submit" disabled={busy}>
                Add rule
              </s-button>
            </s-stack>
          </Form>
        </s-box>
      </s-section>

      <s-section heading="Cost templates">
        <s-paragraph>
          A template is a set of cost blocks you use again and again —
          &ldquo;Imported from EU&rdquo;, say — typed once and applied to any
          product. Create one from a product page: set up the blocks, then
          &ldquo;Save these blocks as a template&rdquo;. Applying a template
          copies its blocks, so editing or deleting a template never changes
          products that already used it.
        </s-paragraph>

        {templates.length === 0 ? (
          <s-text color="subdued">
            No templates yet. Build your first on any product page.
          </s-text>
        ) : (
          templates.map((template) => (
            <s-box
              key={template.id}
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-stack direction="block" gap="small-400">
                <Form method="post">
                  <input type="hidden" name="intent" value="template-rename" />
                  <input type="hidden" name="id" value={template.id} />
                  <s-stack direction="inline" gap="base" alignItems="end">
                    <s-text-field
                      name="name"
                      label="Name"
                      defaultValue={template.name}
                    />
                    <s-button type="submit" disabled={busy}>
                      Rename
                    </s-button>
                  </s-stack>
                </Form>
                <s-text color="subdued">
                  {template.blocks
                    .map((block) =>
                      block.kind === "PERCENT_OF_COST"
                        ? `${block.label} ${formatPercent(block.value)}`
                        : `${block.label} ${formatMoney(block.value, currencyCode)}`,
                    )
                    .join(" · ")}
                </s-text>
                <Form method="post">
                  <input type="hidden" name="intent" value="template-delete" />
                  <input type="hidden" name="id" value={template.id} />
                  <s-button variant="tertiary" tone="critical" type="submit">
                    Delete
                  </s-button>
                </Form>
              </s-stack>
            </s-box>
          ))
        )}
      </s-section>

      <s-section heading="How margin is worked out">
        <s-paragraph>
          Net revenue is the price {settings.pricesIncludeTax ? "minus" : "plus no"}{" "}
          tax. Landed cost is Shopify&rsquo;s cost per item plus the cost
          blocks you add on the product page — flat amounts and percentages of
          the goods cost. Shop-wide rules come off after that. What is left is
          net profit, and net margin is that as a share of net revenue.
          Anything under {formatPercent(settings.criticalMarginPct)} is
          flagged critical.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
