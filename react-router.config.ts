import type { Config } from "@react-router/dev/config";

export default {
  // Shopify embedded apps are server-rendered so that the App Bridge session
  // token is available on the very first paint inside the admin iframe.
  ssr: true,
} satisfies Config;
