import { Link, Outlet, useLoaderData, useRouteError } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
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
