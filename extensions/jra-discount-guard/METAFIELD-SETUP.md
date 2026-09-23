# MAP Restricted product control

Create this merchant-editable product metafield in Shopify Admin:

- Name: MAP Restricted
- Namespace and key: `custom.map_restricted`
- Type: True or false (`boolean`)
- Default: false / unset

Discount Guard treats a product as restricted when either:

1. `custom.map_restricted` is `true`, or
2. the product has the exact tag `MAP Restricted`.

Recommended workflow: use the metafield as the structured source of truth and optionally add the `MAP Restricted` tag as a visible admin marker.

No vendor names are stored in or required by the app. To restrict any current or future vendor, set the same metafield/tag on its products.
