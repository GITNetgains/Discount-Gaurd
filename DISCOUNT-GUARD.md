# James River Archery Discount Guard — implementation notes

Works on **every Shopify plan** (no Shopify Plus / Shopify Functions needed).

## How it works

1. The app keeps a hidden, unpublished collection
   `discount-guard-eligible` ("Discount Guard – Eligible (managed by app)").
2. Every Discount Guard code is a native Shopify *amount off products* code
   discount that applies only to that collection.
3. The collection is kept current by:
   - `products/create` and `products/update` webhooks (per-product sync), and
   - the **Resync eligible products** button on the app home page (full catalog).
   The first code created on a store builds the collection automatically.

Do not edit or delete the collection by hand. If it is deleted, existing codes
lose their target; create/resync from the app to rebuild, then recreate codes.

## Eligibility rules

A product is excluded when **any** of these is true:

- Compare-at price: any variant has a compare-at price set, regardless of whether
  it is greater than, equal to, or less than the current price, when the Settings
  protection switch is ON (the default). OFF removes only this restriction.
- MAP: product metafield `custom.map_restricted` is `true`.
- MAP: product has the tag `MAP Restricted` (case-insensitive).

Collections work per product, so a product with even one compare-priced variant is
excluded entirely (safer than the old per-line function, which only skipped the
on-sale variant).

## Protection settings

`/app/settings` provides the compare-at ON/OFF switch. Save & resync updates the
eligible collection for existing codes; product webhooks use the saved shop rule.
Normal-price products stay eligible, subject to the existing MAP restrictions.
Existing native amount-off product discounts scoped to collections use unpublished
protected copies of their original collections when ON. These copies exclude only
compare-at products, retain the original selection, and keep discount values and
conditions unchanged. OFF restores original collection targets. Original storefront
collections remain unchanged. Product webhooks and a five-minute sync maintain the
copies and check new native collection-based discounts.
The coverage review lists active discounts and identifies protected scopes.
Third-party app discounts and unsupported target types need separate exclusions.
Shopify has no global per-product exclusion switch for every discount; order-wide
discounts and other apps require changes in the discount that grants the savings.

## MAP Restricted product control

Create this merchant-editable product metafield in Shopify Admin:

- Name: MAP Restricted
- Namespace and key: `custom.map_restricted`
- Type: True or false (`boolean`)

No vendor names are stored in or required by the app. To restrict any current or
future vendor, set the metafield/tag on its products.

## Sale Calendar

Page: **Sale Calendar** in the app nav (`/app/sale-calendar`).

1. Choose one collection. The app only works inside that collection.
2. Upload the holiday sale `.xlsx`. The calendar tab needs `Sale name`,
   `Start Date`, `End Date` and a `Product Name sheet` column whose
   "Products" link points at the sale's products tab. Product tabs list names
   like `Brand - Product - Variant` or `Brand - Product (Variant)`; an optional
   `Product ID` column is used first when present.
3. Review the preview (dates, matched products, problems) and save. Saving
   replaces all sales.

While a sale is live (start <= now < end, store time zone) its products are in
the collection; after the end date they are removed. A background check runs
every 5 minutes on the server, plus right after any change on the page.

How it stays out of the way:

- The app adds its own source, "Sale Calendar (managed by app)", inside the
  chosen collection and only edits that source. The collection's own products
  and rules are never touched. When no sale is live the source is deleted.
- With "Show products in sale order" on, the collection sort is set to Manual
  and live sale products are placed first, with the most recently started sale
  first. Equal start times use sheet order; products within a sale keep sheet order.
- Sales with a missing end date, or an end before the start, are saved but
  never run until their dates are fixed on the page.
- Collections hold whole products: a sheet row for one variant puts the whole
  product in the collection.

The server must stay running for sales to start and end on time, and the
SQLite database must be on persistent storage so sales survive redeploys.
