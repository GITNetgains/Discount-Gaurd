# James River Archery Discount Guard — final implementation notes

- Sale exclusion: compare-at price greater than current price.
- MAP exclusion: `custom.map_restricted` boolean OR exact `MAP Restricted` product tag.
- No vendor names are hard-coded.
- Future MAP-restricted brands require no code changes.
- This package does not deploy or mutate the live store.
