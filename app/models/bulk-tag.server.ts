import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// Bulk add/remove a product tag (e.g. "MAP Restricted") by vendor and/or
// on-sale status, so merchants don't have to tag brands one by one.

type Admin = Pick<AdminApiContext, "graphql">;

export interface MatchedProduct {
  id: string;
  title: string;
  vendor: string;
  onSale: boolean;
  hasTag: boolean;
}

export interface FindFilters {
  vendors: string[];
  onSaleOnly: boolean;
  tag: string;
}

const MUTATION_BATCH_SIZE = 10;

const PRODUCT_VENDORS = `#graphql
  query ProductVendors($cursor: String) {
    productVendors(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes
    }
  }
`;

const BULK_TAG_VARIANTS = `#graphql
  query BulkTagVariants($cursor: String) {
    productVariants(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        price
        compareAtPrice
        product { id title vendor tags }
      }
    }
  }
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runGraphql<T>(
  admin: Admin,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await admin.graphql(query, variables ? { variables } : undefined);
      const json = (await response.json()) as {
        data?: T;
        errors?: { message: string }[];
      };
      if (json.errors?.length) {
        throw new Error(json.errors.map((e) => e.message).join("; "));
      }
      if (!json.data) throw new Error("Admin API returned no data.");
      return json.data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Back off and retry when Shopify's GraphQL cost limit is hit.
      if (/throttl/i.test(message) && attempt < 5) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
}

export async function listVendors(admin: Admin) {
  const vendors: string[] = [];
  let cursor: string | null = null;
  do {
    const data: {
      productVendors: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: string[];
      };
    } = await runGraphql(admin, PRODUCT_VENDORS, { cursor });
    vendors.push(...data.productVendors.nodes);
    cursor = data.productVendors.pageInfo.hasNextPage
      ? data.productVendors.pageInfo.endCursor
      : null;
  } while (cursor);
  return vendors.filter(Boolean).sort((a, b) => a.localeCompare(b));
}

/**
 * Products matching ALL chosen filters: vendor in `vendors` (when any are
 * chosen) and, with `onSaleOnly`, at least one variant with compare-at > price.
 */
export async function findProducts(
  admin: Admin,
  filters: FindFilters,
): Promise<MatchedProduct[]> {
  const vendorSet = new Set(filters.vendors);
  const tag = filters.tag.trim().toLowerCase();
  const products = new Map<string, MatchedProduct>();
  let cursor: string | null = null;

  do {
    const data: {
      productVariants: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          price: string;
          compareAtPrice: string | null;
          product: { id: string; title: string; vendor: string; tags: string[] };
        }[];
      };
    } = await runGraphql(admin, BULK_TAG_VARIANTS, { cursor });

    for (const variant of data.productVariants.nodes) {
      const { product } = variant;
      if (vendorSet.size && !vendorSet.has(product.vendor)) continue;

      const onSale =
        variant.compareAtPrice !== null &&
        Number(variant.compareAtPrice) > Number(variant.price);
      const existing = products.get(product.id);
      if (existing) {
        existing.onSale ||= onSale;
      } else {
        products.set(product.id, {
          id: product.id,
          title: product.title,
          vendor: product.vendor,
          onSale,
          hasTag: product.tags.some((t) => t.trim().toLowerCase() === tag),
        });
      }
    }

    cursor = data.productVariants.pageInfo.hasNextPage
      ? data.productVariants.pageInfo.endCursor
      : null;
  } while (cursor);

  return [...products.values()]
    .filter((p) => !filters.onSaleOnly || p.onSale)
    .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.title.localeCompare(b.title));
}

/** Adds or removes `tag` on the given products. Returns per-product failures. */
export async function applyTag(
  admin: Admin,
  productIds: string[],
  tag: string,
  mode: "add" | "remove",
) {
  const field = mode === "add" ? "tagsAdd" : "tagsRemove";
  const failures: { id: string; message: string }[] = [];

  for (let i = 0; i < productIds.length; i += MUTATION_BATCH_SIZE) {
    const batch = productIds.slice(i, i + MUTATION_BATCH_SIZE);
    const variableDefs = batch.map((_, j) => `$id${j}: ID!`).join(", ");
    const fields = batch
      .map((_, j) => `p${j}: ${field}(id: $id${j}, tags: $tags) { userErrors { message } }`)
      .join("\n");
    const mutation = `mutation BulkTag(${variableDefs}, $tags: [String!]!) {\n${fields}\n}`;
    const variables: Record<string, unknown> = { tags: [tag] };
    batch.forEach((id, j) => (variables[`id${j}`] = id));

    const data = await runGraphql<Record<string, { userErrors: { message: string }[] }>>(
      admin,
      mutation,
      variables,
    );
    batch.forEach((id, j) => {
      const errors = data[`p${j}`]?.userErrors ?? [];
      if (errors.length) {
        failures.push({ id, message: errors.map((e) => e.message).join("; ") });
      }
    });
  }

  return failures;
}
