The snippet loads sale headings only on collection pages. The app endpoint checks
the collection ID against the shop's current Sale Calendar selection before
returning any groups. No collection handle is hardcoded.

Copy `snippets/discount-guard-sale-groups.liquid` into the theme and add
`{% render 'discount-guard-sale-groups' %}` immediately before `</body>` in
`layout/theme.liquid`. The script reuses the theme's existing cards, filters and
pagination; it groups the products visible on each page and handles AJAX updates.
Live sales appear by start time, newest first; equal start times use sheet order.
Products shared by multiple live sales appear under the newest sale only.
Unmanaged collection products remain after the sale groups. An unavailable app
leaves the normal theme grid visible.

On the selected collection the app returns, in the same request, the handles of
products with no variant available for sale (read-only Admin API lookup, cached
for one minute). Those cards are hidden and moved to the end of the grid, and the
grid is reflowed so hidden cards never leave blank slots. If the app is
unavailable the theme grid is left as is. Lazy image URLs are activated after
regrouping so moved cards do not depend on the theme observing them again.

The default adapter supports Showcase's collection grid and Dawn's product grid.
The app must be hosted at the URL used in the snippet. This integration performs
no discount, price, product, or collection mutations.
