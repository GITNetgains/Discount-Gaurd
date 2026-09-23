import type { Config } from "@react-router/dev/config";

// Related: https://github.com/remix-run/remix/issues/2835#issuecomment-1144102176
// Same HOST -> SHOPIFY_APP_URL normalization as vite.config.ts, so this file
// sees the same effective app URL regardless of load order.
if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL ||
    process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

const appHost = process.env.SHOPIFY_APP_URL
  ? new URL(process.env.SHOPIFY_APP_URL).hostname
  : null;

export default {
  // React Router validates that action (mutation) requests' `Origin` header
  // matches the request URL's own origin, to guard against CSRF. Shopify's
  // dev tunnel/proxy terminates TLS in front of this app (so the app sees
  // `http://localhost:PORT` while the browser's real `Origin` is the public
  // https tunnel/admin domain), and embedded apps are also loaded inside a
  // Shopify admin iframe. Both cases make the browser's Origin legitimately
  // differ from what this server sees, so those origins must be allow-listed
  // explicitly or every action submission fails with "Bad Request".
  allowedActionOrigins: [
    "admin.shopify.com",
    "**.myshopify.com",
    "**.trycloudflare.com",
    ...(appHost ? [appHost] : []),
  ],
} satisfies Config;
