import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

/**
 * Entry point for anyone hitting the app URL directly.
 *
 * With managed installation Shopify sends merchants straight to /app, so this
 * only handles the "?shop=" case (a link from outside the admin) and an
 * otherwise bare visit.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
}

export default function Index() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "3rem", maxWidth: "40rem" }}>
      <h1>Margin Lens</h1>
      <p>
        See the real margin on every product, including freight, duty,
        packaging and payment fees — right on the Shopify product page.
      </p>
      <p>Open this app from your Shopify admin to get started.</p>
    </main>
  );
}
