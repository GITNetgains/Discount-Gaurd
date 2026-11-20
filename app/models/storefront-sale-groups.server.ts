import prisma from "../db.server";
import { liveSaleGroups, soldOutCandidates } from "../lib/storefront-sale-groups";
import { unauthenticated } from "../shopify.server";

export const SALE_PRODUCT_HANDLES = `#graphql
  query SaleCalendarStorefrontProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id handle onlineStoreUrl }
    }
  }
`;

const COLLECTION_STOCK = `#graphql
  query SaleCalendarCollectionStock($id: ID!, $after: String) {
    collection(id: $id) {
      products(first: 250, after: $after) {
        nodes { id handle tracksInventory totalInventory }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const VARIANT_AVAILABILITY = `#graphql
  query SaleCalendarVariantAvailability($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        handle
        variants(first: 100) {
          nodes { availableForSale }
          pageInfo { hasNextPage }
        }
      }
    }
  }
`;

type Groups = { name: string; startsAt: string; endsAt: string; handles: string[] }[];
export type StorefrontSaleData = { groups: Groups; soldOut: string[]; timezone?: string };
type Admin = Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];

const cache = new Map<string, { expires: number; value: Promise<unknown> }>();

function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) return existing.value as Promise<T>;
  const value = load();
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + ttl, value });
  value.catch(() => cache.delete(key));
  return value;
}

async function graphql<T>(admin: Admin, query: string, variables: Record<string, unknown>) {
  const response = await admin.graphql(query, { variables });
  const result = await response.json() as { errors?: { message: string }[]; data?: T };
  if (result.errors?.length || !result.data) throw new Error("Unable to load sale products.");
  return result.data;
}

async function saleHandles(admin: Admin, groups: ReturnType<typeof liveSaleGroups>): Promise<Groups> {
  const ids = groups.flatMap((group) => group.productIds);
  const handles = new Map<string, string>();
  for (let index = 0; index < ids.length; index += 100) {
    const data = await graphql<{ nodes: ({ id: string; handle: string; onlineStoreUrl: string | null } | null)[] }>(
      admin, SALE_PRODUCT_HANDLES, { ids: ids.slice(index, index + 100) });
    for (const product of data.nodes ?? []) {
      if (product?.onlineStoreUrl) handles.set(product.id, product.handle);
    }
  }
  return groups.map((group) => ({
    name: group.name,
    startsAt: group.startsAt,
    endsAt: group.endsAt,
    handles: group.productIds.flatMap((id) => handles.has(id) ? [handles.get(id)!] : []),
  })).filter((group) => group.handles.length);
}

/** Handles of collection products with no variant available for sale. Read-only. */
async function soldOutHandles(admin: Admin, collectionGid: string): Promise<string[]> {
  type Page = { collection: { products: {
    nodes: { id: string; handle: string; tracksInventory: boolean; totalInventory: number }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  } } | null };
  const candidates: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < 40; page++) {
    const data: Page = await graphql<Page>(admin, COLLECTION_STOCK, { id: collectionGid, after });
    if (!data.collection) return [];
    candidates.push(...soldOutCandidates(data.collection.products.nodes));
    if (!data.collection.products.pageInfo.hasNextPage) break;
    after = data.collection.products.pageInfo.endCursor;
  }
  // Zero tracked stock can still be sellable ("continue selling"), so confirm per variant.
  const soldOut: string[] = [];
  for (let index = 0; index < candidates.length; index += 10) {
    const data = await graphql<{ nodes: ({ handle: string; variants: {
      nodes: { availableForSale: boolean }[]; pageInfo: { hasNextPage: boolean };
    } } | null)[] }>(admin, VARIANT_AVAILABILITY, { ids: candidates.slice(index, index + 10) });
    for (const product of data.nodes ?? []) {
      if (!product || product.variants.pageInfo.hasNextPage) continue;
      if (!product.variants.nodes.some((variant) => variant.availableForSale)) soldOut.push(product.handle);
    }
  }
  return soldOut;
}

export async function storefrontSaleGroups(shop: string, collectionId: string): Promise<StorefrontSaleData> {
  const collectionGid = `gid://shopify/Collection/${collectionId}`;
  const settings = await prisma.saleSettings.findUnique({ where: { shop } });
  if (settings?.collectionId !== collectionGid) return { groups: [], soldOut: [] };

  const sales = await prisma.sale.findMany({
    where: { shop },
    include: { products: { orderBy: { position: "asc" } } },
  });
  const live = liveSaleGroups(sales);
  const { admin } = await unauthenticated.admin(shop);
  const [groups, soldOut] = await Promise.all([
    live.length
      ? cached(JSON.stringify(["groups", shop, collectionId, live]), 30_000, () => saleHandles(admin, live))
      : Promise.resolve([]),
    cached(JSON.stringify(["stock", shop, collectionId]), 60_000, () => soldOutHandles(admin, collectionGid)),
  ]);
  return { groups, soldOut, timezone: settings.timezone };
}
