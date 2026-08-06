import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// The Shopify CLI injects a tunnel URL at dev time. HMR has to be told to talk
// to that host over 443, otherwise the browser tries to reach localhost from
// inside the admin iframe and the socket never connects.
const host = process.env.SHOPIFY_APP_URL
  ? new URL(process.env.SHOPIFY_APP_URL).hostname
  : "localhost";

const hmrConfig =
  host === "localhost"
    ? { protocol: "ws" as const, host: "localhost", port: 64999, clientPort: 64999 }
    : { protocol: "wss" as const, host, port: 443, clientPort: 443 };

export default defineConfig({
  server: {
    allowedHosts: [host],
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: {
      // Vite defaults to only serving from the project root.
      allow: ["app", "node_modules"],
    },
  },
  plugins: [reactRouter(), tsconfigPaths()],
  build: {
    assetsInlineLimit: 0,
  },
});
