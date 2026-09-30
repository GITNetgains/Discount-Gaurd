import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// Discount Guard works on every Shopify plan by keeping a hidden, app-managed
// collection of eligible products and pointing a native Shopify discount code
// at that collection. (Shopify Functions in a custom app need Shopify Plus.)
//
// A product is eligible only when:
//   - it is NOT MAP restricted (`custom.map_restricted` = true OR tag "MAP Restricted"), and
//   - NONE of its variants is on sale (compare-at price > price).
// Collections work at product level, so a product with any on-sale variant is
// excluded entirely — this errs on the side of never over-discounting.

export const ELIGIBLE_COLLECTION_HANDLE = "discount-guard-eligible";
const ELIGIBLE_COLLECTION_TITLE = "Discount Guard – Eligible (managed by app)";
const MAP_RESTRICTED_TAG = "map restricted";
const SELECTION_BATCH_SIZE = 250;

export interface EligibleCollection {
  collectionId: string;
  sourceId: string;
  created: boolean;
}

export interface SyncResult {
  eligible: number;
  excluded: number;
  added: number;
  removed: number;
}

interface VariantNode {
  price: string;
  compareAtPrice: string | null;
  product: {
    id: string;
    tags: string[];
    mapRestricted: { value: string } | null;
  };
}

interface GraphqlJson<T> {
  data?: T;
  errors?: { message: string }[] | unknown;
}

async function runGraphql<T>(
  admin: Pick<AdminApiContext, "graphql">,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const json = (await response.json()) as GraphqlJson<T>;
  if (Array.isArray(json.errors) && json.errors.length) {
    throw new Error(json.errors.map((e: { message: string }) => e.message).join("; "));
  }
  if (!json.data) {
    throw new Error("Admin API returned no data.");
  }
  return json.data;
}

function assertNoUserErrors(userErrors: { message: string }[] | undefined) {
  if (userErrors?.length) {
    throw new Error(userErrors.map((e) => e.message).join("; "));
  }
}

function isVariantOnSale(variant: VariantNode) {
  if (!variant.compareAtPrice) return false;
  return Number(variant.compareAtPrice) > Number(variant.price);
}

function isMapRestricted(product: VariantNode["product"]) {
  const byMetafield =
    product.mapRestricted?.value?.trim().toLowerCase() === "true";
  const byTag = product.tags.some(
    (tag) => tag.trim().toLowerCase() === MAP_RESTRICTED_TAG,
  );
  return byMetafield || byTag;
}

const FIND_COLLECTION = `#graphql
  query FindEligibleCollection($handle: String!) {
    collectionByIdentifier(identifier: { handle: $handle }) {
      id
      sources { __typename id }
    }
  }
`;

const CREATE_COLLECTION = `#graphql
  mutation CreateEligibleCollection($collection: CollectionCreateInput!) {
    collectionCreate(collection: $collection) {
      collection {
        id
        sources { __typename id }
      }
      userErrors { field message }
    }
  }
`;

const UPDATE_SELECTIONS = `#graphql
  mutation UpdateEligibleSelections(
    $collectionId: ID!
    $sourceId: ID!
    $add: [CollectionInclusionProductSelectionInput!]
    $remove: [CollectionInclusionProductSelectionInput!]
  ) {
    collectionUpdate(collection: {
      id: $collectionId
      sourcesToUpdate: [{ condition: { id: $sourceId, inclusion: { selectionsToAdd: $add, selectionsToRemove: $remove } } }]
    }) {
      collection { id }
      userErrors { field message }
    }
  }
`;

const ELIGIBILITY_VARIANTS = `#graphql
  query EligibilityVariants($cursor: String, $query: String) {
    productVariants(first: 250, after: $cursor, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        price
        compareAtPrice
        product {
          id
          tags
          mapRestricted: metafield(namespace: "custom", key: "map_restricted") { value }
        }
      }
    }
  }
`;

const COLLECTION_MEMBERS = `#graphql
  query CollectionMembers($id: ID!, $cursor: String) {
    collection(id: $id) {
      products(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

const PRODUCT_IN_COLLECTION = `#graphql
  query ProductInCollection($id: ID!, $collectionId: ID!) {
    product(id: $id) {
      id
      inCollection(id: $collectionId)
    }
  }
`;

type CollectionNode = {
  id: string;
  sources: { __typename: string; id: string }[];
};

function conditionsSourceId(collection: CollectionNode) {
  const source = collection.sources.find(
    (s) => s.__typename === "CollectionConditionsSource",
  );
  if (!source) {
    throw new Error(
      `Collection "${ELIGIBLE_COLLECTION_HANDLE}" has no manual selection source. Delete it and resync so the app can recreate it.`,
    );
  }
  return source.id;
}

export async function findEligibleCollection(
  admin: Pick<AdminApiContext, "graphql">,
): Promise<Omit<EligibleCollection, "created"> | null> {
  const data = await runGraphql<{ collectionByIdentifier: CollectionNode | null }>(
    admin,
    FIND_COLLECTION,
    { handle: ELIGIBLE_COLLECTION_HANDLE },
  );
  const collection = data.collectionByIdentifier;
  if (!collection) return null;
  return { collectionId: collection.id, sourceId: conditionsSourceId(collection) };
}

export async function ensureEligibleCollection(
  admin: Pick<AdminApiContext, "graphql">,
): Promise<EligibleCollection> {
  const existing = await findEligibleCollection(admin);
  if (existing) return { ...existing, created: false };

  // Collections are unpublished by default, so customers never see this one.
  const data = await runGraphql<{
    collectionCreate: {
      collection: CollectionNode | null;
      userErrors: { message: string }[];
    };
  }>(admin, CREATE_COLLECTION, {
    collection: {
      title: ELIGIBLE_COLLECTION_TITLE,
      handle: ELIGIBLE_COLLECTION_HANDLE,
      descriptionHtml:
        "Managed automatically by the Discount Guard app. Do not edit or delete — Discount Guard codes apply only to products in this collection.",
      sources: [
        {
          source: {
            title: "Discount Guard eligible products",
            targetType: "PRODUCTS",
            inclusion: { matchType: "ALL", selections: [] },
          },
        },
      ],
    },
  });
  assertNoUserErrors(data.collectionCreate.userErrors);
  const collection = data.collectionCreate.collection!;
  return {
    collectionId: collection.id,
    sourceId: conditionsSourceId(collection),
    created: true,
  };
}

async function updateSelections(
  admin: Pick<AdminApiContext, "graphql">,
  collection: Omit<EligibleCollection, "created">,
  add: string[],
  remove: string[],
) {
  const toSelections = (ids: string[]) => ids.map((productId) => ({ productId }));

  for (let i = 0; i < add.length; i += SELECTION_BATCH_SIZE) {
    const data = await runGraphql<{
      collectionUpdate: { userErrors: { message: string }[] };
    }>(admin, UPDATE_SELECTIONS, {
      collectionId: collection.collectionId,
      sourceId: collection.sourceId,
      add: toSelections(add.slice(i, i + SELECTION_BATCH_SIZE)),
      remove: [],
    });
    assertNoUserErrors(data.collectionUpdate.userErrors);
  }

  for (let i = 0; i < remove.length; i += SELECTION_BATCH_SIZE) {
    const data = await runGraphql<{
      collectionUpdate: { userErrors: { message: string }[] };
    }>(admin, UPDATE_SELECTIONS, {
      collectionId: collection.collectionId,
      sourceId: collection.sourceId,
      add: [],
      remove: toSelections(remove.slice(i, i + SELECTION_BATCH_SIZE)),
    });
    assertNoUserErrors(data.collectionUpdate.userErrors);
  }
}

// Returns productId -> eligible for every product touched by the variant query.
async function evaluateProducts(
  admin: Pick<AdminApiContext, "graphql">,
  query?: string,
) {
  const eligibility = new Map<string, boolean>();
  let cursor: string | null = null;

  do {
    const data: {
      productVariants: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: VariantNode[];
      };
    } = await runGraphql(admin, ELIGIBILITY_VARIANTS, { cursor, query });

    for (const variant of data.productVariants.nodes) {
      const productId = variant.product.id;
      const eligible =
        (eligibility.get(productId) ?? true) &&
        !isVariantOnSale(variant) &&
        !isMapRestricted(variant.product);
      eligibility.set(productId, eligible);
    }

    cursor = data.productVariants.pageInfo.hasNextPage
      ? data.productVariants.pageInfo.endCursor
      : null;
  } while (cursor);

  return eligibility;
}

async function currentMembers(
  admin: Pick<AdminApiContext, "graphql">,
  collectionId: string,
) {
  const members = new Set<string>();
  let cursor: string | null = null;

  do {
    const data: {
      collection: {
        products: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: { id: string }[];
        };
      } | null;
    } = await runGraphql(admin, COLLECTION_MEMBERS, { id: collectionId, cursor });

    if (!data.collection) break;
    for (const product of data.collection.products.nodes) members.add(product.id);
    cursor = data.collection.products.pageInfo.hasNextPage
      ? data.collection.products.pageInfo.endCursor
      : null;
  } while (cursor);

  return members;
}

/** Full catalog resync: recomputes eligibility for every product. */
export async function syncAllProducts(
  admin: Pick<AdminApiContext, "graphql">,
): Promise<SyncResult> {
  const collection = await ensureEligibleCollection(admin);
  const [eligibility, members] = await Promise.all([
    evaluateProducts(admin),
    currentMembers(admin, collection.collectionId),
  ]);

  const add: string[] = [];
  const remove: string[] = [];
  let eligibleCount = 0;

  for (const [productId, eligible] of eligibility) {
    if (eligible) {
      eligibleCount += 1;
      if (!members.has(productId)) add.push(productId);
    } else if (members.has(productId)) {
      remove.push(productId);
    }
  }

  await updateSelections(admin, collection, add, remove);

  return {
    eligible: eligibleCount,
    excluded: eligibility.size - eligibleCount,
    added: add.length,
    removed: remove.length,
  };
}

/** Incremental sync for a single product (used by product webhooks). */
export async function syncProduct(
  admin: Pick<AdminApiContext, "graphql">,
  productGid: string,
) {
  const collection = await findEligibleCollection(admin);
  // Nothing to maintain until the merchant creates their first Discount Guard code.
  if (!collection) return;

  const numericId = productGid.split("/").pop();
  const eligibility = await evaluateProducts(admin, `product_id:${numericId}`);
  const eligible = eligibility.get(productGid) ?? false;

  const data = await runGraphql<{
    product: { id: string; inCollection: boolean } | null;
  }>(admin, PRODUCT_IN_COLLECTION, {
    id: productGid,
    collectionId: collection.collectionId,
  });
  if (!data.product) return;

  if (eligible && !data.product.inCollection) {
    await updateSelections(admin, collection, [productGid], []);
  } else if (!eligible && data.product.inCollection) {
    await updateSelections(admin, collection, [], [productGid]);
  }
}
