import type React from "react";

/**
 * App Bridge web components render into the admin chrome outside the app's
 * iframe. They are registered at runtime by the App Bridge script that
 * `AppProvider` injects, so they ship no npm types — declare the ones we use.
 *
 * Augmenting `react`'s own JSX namespace (rather than a global one) is required
 * from React 19 onwards, where the global `JSX` namespace no longer exists.
 * This mirrors how `@shopify/polaris-types` declares the `s-*` elements.
 */
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "ui-nav-menu": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
      "ui-title-bar": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { title?: string },
        HTMLElement
      >;
      "ui-save-bar": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { id?: string },
        HTMLElement
      >;
    }
  }
}

export {};
