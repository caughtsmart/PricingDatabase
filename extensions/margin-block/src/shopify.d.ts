/**
 * Types for the extension's ambient `shopify` global and the `s-*` web
 * components.
 *
 * The target module is imported here rather than in the .tsx because it
 * resolves to a declaration file with no runtime counterpart — importing it
 * from application code would break the bundle. The side-effect import
 * registers every component this target can render into Preact's JSX
 * namespace.
 */
import "@shopify/ui-extensions/admin.product-details.block.render";
import type { Api } from "@shopify/ui-extensions/admin.product-details.block.render";

declare global {
  const shopify: Api;
}
