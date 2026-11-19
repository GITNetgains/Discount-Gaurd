export interface StorefrontSale {
  name: string;
  position: number;
  startsAt: Date | null;
  endsAt: Date | null;
  products: { productId: string; position: number }[];
}

/** Products whose tracked stock is used up; variants still decide if they can be sold. */
export function soldOutCandidates(products: { id: string; tracksInventory: boolean; totalInventory: number }[]) {
  return products
    .filter((product) => product.tracksInventory && product.totalInventory <= 0)
    .map((product) => product.id);
}

export function newestSaleFirst(
  a: { startsAt: Date | null; position: number },
  b: { startsAt: Date | null; position: number },
) {
  return (b.startsAt?.getTime() ?? 0) - (a.startsAt?.getTime() ?? 0)
    || a.position - b.position;
}

export function liveSaleGroups(sales: StorefrontSale[], now = new Date()) {
  const seen = new Set<string>();
  return sales
    .filter((sale) => sale.startsAt && sale.endsAt && sale.startsAt <= now && now < sale.endsAt)
    .sort(newestSaleFirst)
    .map((sale) => ({
      name: sale.name,
      productIds: [...sale.products]
        .sort((a, b) => a.position - b.position)
        .map((product) => product.productId)
        .filter((id) => {
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        }),
    }))
    .filter((group) => group.productIds.length);
}
