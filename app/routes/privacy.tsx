/**
 * The public privacy policy.
 *
 * The App Store listing requires a privacy policy URL, and this page is it —
 * deliberately served by the app itself so the policy and the code that has
 * to honour it live in the same repository and change together. Everything
 * stated here is backed by `app/lib/gdpr.server.ts` and the sync queries:
 * if a claim on this page stops being true, the change that broke it should
 * have to walk past this file to ship.
 *
 * Public and unauthenticated on purpose; it must be readable before install.
 */

const updated = "8 August 2026";

const styles = {
  main: {
    fontFamily: "system-ui, sans-serif",
    padding: "3rem 1.5rem",
    maxWidth: "44rem",
    margin: "0 auto",
    lineHeight: 1.6,
  },
  h2: { marginTop: "2.5rem" },
  subdued: { color: "#555" },
} as const;

export default function Privacy() {
  return (
    <main style={styles.main}>
      <h1>CogsPilot privacy policy</h1>
      <p style={styles.subdued}>Last updated {updated}</p>

      <p>
        CogsPilot is a Shopify app that shows merchants the real margin on
        their products. This page explains exactly what data the app stores,
        why, and what happens to it when you leave. The short version:{" "}
        <strong>
          CogsPilot stores no data about your customers at all
        </strong>{" "}
        — its business is your costs, not your buyers.
      </p>

      <h2 style={styles.h2}>What we store, and why</h2>
      <ul>
        <li>
          <strong>Your catalogue.</strong> Product and variant titles, prices,
          stock levels and Shopify&rsquo;s &ldquo;cost per item&rdquo;, cached
          so your dashboard loads from one database query instead of hundreds
          of API calls.
        </li>
        <li>
          <strong>Your cost figures.</strong> The cost blocks, templates,
          rules and settings you type into the app. This is the data the app
          exists to keep.
        </li>
        <li>
          <strong>Sales quantities.</strong> To report realised margin, the
          app reads how many units of each variant sold. That query asks
          Shopify for quantities and variant identifiers only — no names, no
          emails, no addresses, no payment details — and stores a single
          number per variant.
        </li>
        <li>
          <strong>Staff sign-in sessions.</strong> Shopify&rsquo;s standard
          app session: your shop&rsquo;s domain, an access token, and for the
          staff member using the app, their name and email. This is merchant
          staff data, never customer data.
        </li>
      </ul>

      <h2 style={styles.h2}>What we never collect</h2>
      <p>
        Customer names, emails, addresses, phone numbers, order notes, payment
        details, browsing behaviour — none of it is requested from Shopify,
        and none of it is stored. Because the app holds no customer data,
        a customer data request or erasure request under GDPR finds nothing
        to disclose or erase; both are still logged and answered as Shopify
        requires.
      </p>

      <h2 style={styles.h2}>Where it lives and who sees it</h2>
      <p>
        Your data is stored in the app&rsquo;s own database, keyed to your
        shop&rsquo;s domain, and is never shared with, sold to, or enriched
        by any third party. It is used solely to show you your margins. Log
        lines are scrubbed of secrets before they are written.
      </p>

      <h2 style={styles.h2}>When you uninstall</h2>
      <p>
        Uninstalling revokes the app&rsquo;s access immediately. Your cost
        figures are kept for a grace period in case you reinstall — merchants
        who typed in a catalogue&rsquo;s worth of landed costs tend to want
        them back. When Shopify sends the shop redaction request (48 hours
        after uninstall), everything the app holds for your shop is deleted
        in a single transaction: catalogue cache, cost blocks, templates,
        rules, settings and sessions. Only the compliance log proving the
        deletion happened is retained, and it contains no personal data.
      </p>

      <h2 style={styles.h2}>Contact</h2>
      <p>
        Questions about this policy or your data:{" "}
        <a href="mailto:graham@loadeddice.uk">graham@loadeddice.uk</a>. We aim
        to reply within two working days.
      </p>
    </main>
  );
}
