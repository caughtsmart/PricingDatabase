import { Link, Outlet, useLoaderData, useRouteError } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import {
  getSubscriptionStatus,
  isBillingEnforced,
  planSelectionUrl,
} from "../lib/billing.server";
import type { GraphQLClient } from "../lib/catalog.server";
import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session, redirect } = await authenticate.admin(request);

  const subscription = await getSubscriptionStatus(admin.graphql as GraphQLClient);
  const planUrl = planSelectionUrl(session.shop);

  // Gating lives in the layout so it applies to every page underneath, however
  // the merchant arrived. `target: "_top"` is required: the app runs in an
  // iframe and cannot navigate the admin's parent window on its own.
  if (!subscription.active && isBillingEnforced()) {
    throw redirect(planUrl, { target: "_top" });
  }

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    subscription,
    planUrl,
    billingEnforced: isBillingEnforced(),
  };
}

export default function AppLayout() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      {/* Rendered by App Bridge into the admin chrome, outside the iframe. */}
      <ui-nav-menu>
        <Link to="/app" rel="home">
          Dashboard
        </Link>
        <Link to="/app/products">Products</Link>
        <Link to="/app/settings">Settings</Link>
      </ui-nav-menu>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs these exports so that embedded errors and headers propagate
// correctly through the admin iframe.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: typeof boundary.headers = (headersArgs) =>
  boundary.headers(headersArgs);
