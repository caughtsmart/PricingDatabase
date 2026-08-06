import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Builds the standalone worker into a single JavaScript entry point.
 *
 * The worker shares its module graph with the app (`app/queue.server.ts` and
 * everything it pulls in), so it cannot simply be run through Node's
 * type-stripping: that resolver does not fill in extensions the way a bundler
 * does, and every internal import in the graph would need an explicit `.ts`.
 *
 * Bundling instead keeps the source clean and means production runs plain JS
 * with no TypeScript toolchain present. `ssr: true` leaves node_modules
 * external, so this emits one small file rather than inlining Prisma.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  build: {
    ssr: true,
    outDir: "build/worker",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    rollupOptions: {
      input: "worker.ts",
      output: {
        format: "esm",
        entryFileNames: "worker.js",
      },
    },
  },
});
