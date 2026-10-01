import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// Bulk add/remove a product tag (e.g. "MAP Restricted") by vendor and/or
// on-sale status, so merchants don't have to tag brands one by one.

type Admin = Pick<AdminApiContext, "graphql">;

/** One product as seen in a scan chunk (a product can span two chunks). */
export interface ScannedProduct {
  id: string;
  title: string;
  vendor: string;
  tags: string[];
  /** Some variant has compare-at price greater than its price. */
  onSale: boolean;
  /** Some variant has any compare-at price set. */
  hasCompareAt: boolean;
}

const MUTATION_BATCH_SIZE = 10;
// Variant pages (250 each) per scan request; keeps each request well under
// proxy timeouts even on large catalogs.
const SCAN_PAGES_PER_CHUNK = 6;

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
 * Scans the next chunk of the catalog (every variant of every product,
 * any status). Call repeatedly with the returned cursor until it is null;
 * the client merges products that span chunks.
 */
export async function scanCatalogChunk(admin: Admin, startCursor: string | null) {
  const products = new Map<string, ScannedProduct>();
  let cursor = startCursor;
  let variantsScanned = 0;

  for (let page = 0; page < SCAN_PAGES_PER_CHUNK; page += 1) {
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
      const hasCompareAt =
        variant.compareAtPrice !== null && Number(variant.compareAtPrice) > 0;
      const onSale =
        hasCompareAt && Number(variant.compareAtPrice) > Number(variant.price);

      const existing = products.get(product.id);
      if (existing) {
        existing.onSale ||= onSale;
        existing.hasCompareAt ||= hasCompareAt;
      } else {
        products.set(product.id, {
          id: product.id,
          title: product.title,
          vendor: product.vendor,
          tags: product.tags,
          onSale,
          hasCompareAt,
        });
      }
    }
    variantsScanned += data.productVariants.nodes.length;

    cursor = data.productVariants.pageInfo.hasNextPage
      ? data.productVariants.pageInfo.endCursor
      : null;
    if (!cursor) break;
  }

  return { products: [...products.values()], variantsScanned, nextCursor: cursor };
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
