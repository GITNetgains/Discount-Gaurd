import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import type { CompareAtRule } from "../lib/discount-eligibility";
import { scopeReplacement, protectedProductIds } from "../lib/discount-scope";
import { ELIGIBLE_COLLECTION_HANDLE } from "./eligibility.server";

type Admin = Pick<AdminApiContext, "graphql">;
const SOURCE_TITLE = "Discount Guard compare-at protection";
export const PROTECTION_QUERIES = {
  discounts: `#graphql
    query ProtectableDiscounts($cursor: String) {
      discountNodes(first: 25, after: $cursor, query: "status:active OR status:scheduled") {
        pageInfo { hasNextPage endCursor }
        nodes { id discount {
          __typename
          ... on DiscountCodeBasic { title customerGets { items { __typename ... on DiscountCollections { collections(first: 20) { nodes { id handle } pageInfo { hasNextPage } } } } } }
          ... on DiscountAutomaticBasic { title customerGets { items { __typename ... on DiscountCollections { collections(first: 20) { nodes { id handle } pageInfo { hasNextPage } } } } } }
        } }
      }
    }
  `,
  variants: `#graphql
    query ComparePricedProducts($cursor: String) {
      productVariants(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { compareAtPrice product { id } }
      }
    }
  `,
  collection: `#graphql
    query ProtectionCollection($id: ID!, $cursor: String) {
      collection(id: $id) {
        id title handle sources { __typename id title }
        products(first: 250, after: $cursor) { nodes { id } pageInfo { hasNextPage endCursor } }
      }
    }
  `,
  find: `#graphql
    query FindProtectionCollection($handle: String!) {
      collectionByIdentifier(identifier: { handle: $handle }) { id }
    }
  `,
  create: `#graphql
    mutation CreateProtectionCollection($input: CollectionCreateInput!) {
      collectionCreate(collection: $input) { collection { id } userErrors { field message } }
    }
  `,
  update: `#graphql
    mutation UpdateProtectionCollection($input: CollectionUpdateInput!) {
      collectionUpdate(collection: $input) { collection { id sources { id title } } userErrors { field message } }
    }
  `,
  code: `#graphql
    mutation ProtectCodeScope($id: ID!, $input: DiscountCodeBasicInput!) {
      discountCodeBasicUpdate(id: $id, basicCodeDiscount: $input) { codeDiscountNode { id } userErrors { field message } }
    }
  `,
  automatic: `#graphql
    mutation ProtectAutomaticScope($id: ID!, $input: DiscountAutomaticBasicInput!) {
      discountAutomaticBasicUpdate(id: $id, automaticBasicDiscount: $input) { automaticDiscountNode { id } userErrors { field message } }
    }
  `,
};

async function gql<T>(admin: Admin, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await admin.graphql(query, { variables });
    const json = await response.json() as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
    if (json.errors?.some(e => e.extensions?.code === "THROTTLED")) {
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      continue;
    }
    if (json.errors?.length || !json.data) throw new Error(json.errors?.map(e => e.message).join("; ") || "Unable to sync discount protection.");
    return json.data;
  }
  throw new Error("Discount protection API throttled. Retry sync.");
}

function checked<T extends { userErrors: { message: string }[] }>(result: T) {
  if (result.userErrors.length) throw new Error(result.userErrors.map(e => e.message).join("; "));
  return result;
}

interface CollectionState {
  id: string; title: string; handle: string;
  sources: { id: string; title: string | null; __typename: string }[];
  products: { nodes: { id: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
}
async function collectionState(admin: Admin, id: string) {
  let cursor: string | null = null;
  let state: CollectionState | null = null;
  const ids: string[] = [];
  do {
    const page: { collection: CollectionState | null } = await gql(admin, PROTECTION_QUERIES.collection, { id, cursor });
    if (!page.collection) return null;
    state = page.collection;
    ids.push(...state.products.nodes.map(p => p.id));
    cursor = state.products.pageInfo.hasNextPage ? state.products.pageInfo.endCursor : null;
  } while (cursor);
  return { ...state!, ids };
}

async function comparePricedProducts(admin: Admin) {
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    const data: { productVariants: { nodes: { compareAtPrice: string | null; product: { id: string } }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await gql(admin, PROTECTION_QUERIES.variants, { cursor });
    for (const variant of data.productVariants.nodes) if (variant.compareAtPrice?.trim()) ids.add(variant.product.id);
    cursor = data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
  } while (cursor);
  return ids;
}

const selections = (ids: string[]) => ids.map(productId => ({ productId }));
async function updateCollection(admin: Admin, input: Record<string, unknown>) {
  const data = await gql<{ collectionUpdate: { collection: { id: string; sources: { id: string; title: string | null }[] } | null; userErrors: { message: string }[] } }>(admin, PROTECTION_QUERIES.update, { input });
  const collection = checked(data.collectionUpdate).collection;
  if (!collection) throw new Error("Protection collection disappeared during sync.");
  return collection;
}

async function syncMirror(admin: Admin, shop: string, originalId: string, protectedProducts: Set<string>) {
  const original = await collectionState(admin, originalId);
  if (!original) throw new Error(`Original discount collection no longer exists: ${originalId}`);
  const desired = protectedProductIds(original.ids, protectedProducts);
  const handle = `discount-guard-scope-${originalId.split("/").pop()}`;
  const found = await gql<{ collectionByIdentifier: { id: string } | null }>(admin, PROTECTION_QUERIES.find, { handle });
  let id = found.collectionByIdentifier?.id;
  if (!id) {
    const created = await gql<{ collectionCreate: { collection: { id: string } | null; userErrors: { message: string }[] } }>(admin, PROTECTION_QUERIES.create, {
      input: { title: `Discount Guard – ${original.title}`, handle,
        descriptionHtml: "Unpublished, app-managed copy of a discount's original scope, excluding compare-at priced products." },
    });
    id = checked(created.collectionCreate).collection?.id;
    if (!id) throw new Error("Could not create protected discount collection.");
  }
  // Persist before switching discount scopes so OFF always has a reverse mapping.
  await prisma.discountCollectionMirror.upsert({
    where: { shop_originalCollectionId: { shop, originalCollectionId: originalId } },
    create: { shop, originalCollectionId: originalId, protectedCollectionId: id },
    update: { protectedCollectionId: id },
  });
  const current = await collectionState(admin, id);
  if (!current) throw new Error("Protected collection is unavailable.");
  if (current.sources.some(source => source.title !== SOURCE_TITLE)) throw new Error("Protected collection contains an unrecognized source; refusing to overwrite it.");
  const source = current.sources.find(s => s.title === SOURCE_TITLE);
  if (!desired.length) {
    if (source) await updateCollection(admin, { id, sourcesToDelete: [source.id] });
  } else {
    let sourceId = source?.id;
    let add = desired.filter(productId => !current.ids.includes(productId));
    const remove = current.ids.filter(productId => !desired.includes(productId));
    if (!sourceId) {
      const updated = await updateCollection(admin, { id, sourcesToCreate: [{ source: {
        title: SOURCE_TITLE, targetType: "PRODUCTS", inclusion: { selections: selections(desired.slice(0, 250)) },
      } }] });
      sourceId = updated.sources.find(s => s.title === SOURCE_TITLE)?.id;
      if (!sourceId) throw new Error("Could not create protected collection source.");
      add = desired.slice(250);
    }
    for (let index = 0; index < Math.max(add.length, remove.length); index += 250) {
      await updateCollection(admin, { id, sourcesToUpdate: [{ condition: { id: sourceId, inclusion: {
        selectionsToAdd: selections(add.slice(index, index + 250)), selectionsToRemove: selections(remove.slice(index, index + 250)),
      } } }] });
    }
  }
  // Verify membership before connecting any discount to the protected scope.
  for (let attempt = 0; attempt < 15; attempt++) {
    const verified = await collectionState(admin, id);
    if (verified && verified.ids.length === desired.length && verified.ids.every(productId => desired.includes(productId))) return id;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Protected collection membership is still updating: ${original.title}. Retry sync.`);
}

interface DiscountNode {
  id: string;
  discount: { __typename: string; title?: string; customerGets?: { items: {
    __typename: string;
    collections?: { nodes: { id: string; handle: string }[]; pageInfo: { hasNextPage: boolean } };
  } } };
}
const running = new Map<string, Promise<{ updated: number; managed: number; unsupported: number }>>();
export async function syncDiscountProtection(admin: Admin, shop: string, rule: CompareAtRule) {
  // Serialize saves, webhooks, and scheduler runs for the same store.
  const previous = running.get(shop);
  const work = (previous ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const saved = await prisma.discountSettings.findUnique({ where: { shop } });
    return performSync(admin, shop, saved ? (saved.compareAtRule === "off" ? "off" : "any") : rule);
  });
  running.set(shop, work);
  try { return await work; } finally { if (running.get(shop) === work) running.delete(shop); }
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();
export function scheduleDiscountProtection(admin: Admin, shop: string, rule: CompareAtRule) {
  const previous = pending.get(shop);
  if (previous) clearTimeout(previous);
  pending.set(shop, setTimeout(() => {
    pending.delete(shop);
    void syncDiscountProtection(admin, shop, rule).catch(error => console.error(`[discount-protection] ${shop}`, error));
  }, 1500));
}

async function performSync(admin: Admin, shop: string, rule: CompareAtRule) {
  const nodes: DiscountNode[] = [];
  let cursor: string | null = null;
  do {
    const data: { discountNodes: { nodes: DiscountNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await gql(admin, PROTECTION_QUERIES.discounts, { cursor });
    nodes.push(...data.discountNodes.nodes);
    cursor = data.discountNodes.pageInfo.hasNextPage ? data.discountNodes.pageInfo.endCursor : null;
  } while (cursor);
  const mappings = await prisma.discountCollectionMirror.findMany({ where: { shop } });
  const reverse = new Map(mappings.map(m => [m.protectedCollectionId, m.originalCollectionId]));
  const replacements = new Map<string, string>();
  const protectedProducts = rule === "any" ? await comparePricedProducts(admin) : new Set<string>();
  const supported = nodes.filter(node => ["DiscountCodeBasic", "DiscountAutomaticBasic"].includes(node.discount.__typename)
    && node.discount.customerGets?.items.__typename === "DiscountCollections");
  for (const node of supported) {
    const targets = node.discount.customerGets!.items.collections!;
    if (targets.pageInfo.hasNextPage) throw new Error(`Too many target collections to safely protect ${node.discount.title}.`);
    for (const target of targets.nodes) {
      if (target.handle === ELIGIBLE_COLLECTION_HANDLE) continue;
      if (rule === "off") {
        const original = reverse.get(target.id);
        if (original) replacements.set(target.id, original);
      } else {
        const original = reverse.get(target.id) ?? target.id;
        if (!replacements.has(original)) replacements.set(original, await syncMirror(admin, shop, original, protectedProducts));
      }
    }
  }
  let updated = 0;
  for (const node of supported) {
    const targets = node.discount.customerGets!.items.collections!.nodes;
    const delta = scopeReplacement(targets.map(t => t.id), replacements);
    if (!delta.add.length && !delta.remove.length) continue;
    const input = { customerGets: { items: { collections: delta } } };
    const automatic = node.discount.__typename === "DiscountAutomaticBasic";
    const data = await gql<Record<string, { userErrors: { message: string }[] }>>(admin, automatic ? PROTECTION_QUERIES.automatic : PROTECTION_QUERIES.code, { id: node.id, input });
    checked(data[automatic ? "discountAutomaticBasicUpdate" : "discountCodeBasicUpdate"]);
    updated++;
  }
  return { updated, managed: supported.length, unsupported: nodes.filter(n => !supported.includes(n) && !n.discount.__typename.endsWith("FreeShipping")).length };
}
