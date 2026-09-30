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

- Sale: any variant has compare-at price greater than its price.
- MAP: product metafield `custom.map_restricted` is `true`.
- MAP: product has the tag `MAP Restricted` (case-insensitive).

Collections work per product, so a product with even one on-sale variant is
excluded entirely (safer than the old per-line function, which only skipped the
on-sale variant).

## MAP Restricted product control

Create this merchant-editable product metafield in Shopify Admin:

- Name: MAP Restricted
- Namespace and key: `custom.map_restricted`
- Type: True or false (`boolean`)

No vendor names are stored in or required by the app. To restrict any current or
future vendor, set the metafield/tag on its products.
