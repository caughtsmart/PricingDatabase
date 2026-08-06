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
import { formatPercent, parseNumber } from "../lib/format";
import type { CostRuleKind } from "../lib/margin";
import {
  deleteCostRule,
  getShopConfig,
  updateShopSettings,
  upsertCostRule,
} from "../lib/settings.server";
import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const config = await getShopConfig(session.shop);

  // Subscription state comes from the parent `app` route's loader — no need to
  // ask Shopify twice on one page load.
  return {
    settings: config.settings,
    rules: config.rules,
    currencyCode: config.currencyCode,
    autoSyncEnabled: config.autoSyncEnabled,
    syncHour: formatSyncHour(session.shop),
  };
}

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
    return { ok: true, message: "Settings saved." };
  }

  if (intent === "auto-sync") {
    await updateShopSettings(session.shop, {
      autoSyncEnabled: formData.get("autoSyncEnabled") === "on",
    });
    return { ok: true, message: "Sync schedule updated." };
  }

  if (intent === "rule") {
    const name = String(formData.get("name") ?? "").trim();
    if (!name) return { ok: false, message: "Give the cost rule a name." };

    const kind = String(formData.get("kind")) as CostRuleKind;
    if (kind !== "PERCENT_OF_REVENUE" && kind !== "FIXED_PER_UNIT") {
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

  return { ok: false, message: "Unknown action." };
}

export default function Settings() {
  const { settings, rules, currencyCode, autoSyncEnabled, syncHour } =
    useLoaderData<typeof loader>();
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
          payment fees, channel commission, pick and pack. Percentages are taken
          from revenue after tax.
        </s-paragraph>

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
                  <s-option value="PERCENT_OF_REVENUE">% of revenue</s-option>
                  <s-option value="FIXED_PER_UNIT">
                    Fixed per unit ({currencyCode})
                  </s-option>
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
                <s-option value="PERCENT_OF_REVENUE">% of revenue</s-option>
                <s-option value="FIXED_PER_UNIT">
                  Fixed per unit ({currencyCode})
                </s-option>
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

      <s-section heading="How margin is worked out">
        <s-paragraph>
          Net revenue is the price {settings.pricesIncludeTax ? "minus" : "plus no"}{" "}
          tax. Landed cost is Shopify&rsquo;s cost per item plus the freight,
          duty, packaging and handling you enter on the product page. Shop-wide
          rules come off after that. What is left is net profit, and net margin
          is that as a share of net revenue. Anything under{" "}
          {formatPercent(settings.criticalMarginPct)} is flagged critical.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
