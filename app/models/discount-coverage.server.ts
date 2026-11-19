import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

export const DISCOUNT_COVERAGE = `#graphql
  query DiscountCoverage($cursor: String) {
    discountNodes(first: 50, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        discount {
          __typename
          ... on DiscountCodeBasic {
            title
            customerGets { items {
              __typename
              ... on DiscountCollections {
                collections(first: 2) { nodes { id } pageInfo { hasNextPage } }
              }
            } }
          }
          ... on DiscountAutomaticBasic {
            title
            customerGets { items {
              __typename
              ... on DiscountCollections {
                collections(first: 2) { nodes { id } pageInfo { hasNextPage } }
              }
            } }
          }
          ... on DiscountCodeApp { title }
          ... on DiscountAutomaticApp { title }
          ... on DiscountCodeBxgy { title }
          ... on DiscountAutomaticBxgy { title }
          ... on DiscountCodeFreeShipping { title }
          ... on DiscountAutomaticFreeShipping { title }
        }
      }
    }
  }
`;

interface CoverageNode {
  id: string;
  discount: {
    __typename: string;
    title?: string;
    customerGets?: { items: {
      __typename: string;
      collections?: { nodes: { id: string }[]; pageInfo: { hasNextPage: boolean } };
    } };
  };
}

export function discountCoverageRow(node: CoverageNode, collectionId: string | null, protectedCollections: string[] = []) {
  const items = node.discount.customerGets?.items;
  const collections = items?.collections;
  const allowed = new Set([collectionId, ...protectedCollections].filter(Boolean));
  const protectedScope = items?.__typename === "DiscountCollections"
    && !!collections?.nodes.length && collections.nodes.every(node => allowed.has(node.id))
    && !collections.pageInfo.hasNextPage;
  const shippingOnly = node.discount.__typename.endsWith("FreeShipping");
  return {
    id: node.id.split("/").pop()!,
    title: node.discount.title || node.discount.__typename,
    covered: protectedScope,
    shippingOnly,
    reason: protectedScope ? "Uses a protected collection; original discount scope is preserved."
      : shippingOnly ? "Shipping only; does not reduce product prices."
        : "Not limited to the eligible collection. Review this discount before relying on compare-at protection.",
  };
}

export async function getDiscountCoverage(admin: Pick<AdminApiContext, "graphql">, collectionId: string | null, protectedCollections: string[] = []) {
  const rows: ReturnType<typeof discountCoverageRow>[] = [];
  let cursor: string | null = null;
  do {
    const response = await admin.graphql(DISCOUNT_COVERAGE, { variables: { cursor } });
    const json = await response.json() as {
      errors?: { message: string }[];
      data?: { discountNodes: { nodes: CoverageNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
    };
    if (json.errors?.length || !json.data) throw new Error(json.errors?.map(e => e.message).join("; ") || "Unable to review discount coverage.");
    const page = json.data.discountNodes;
    rows.push(...page.nodes.map(node => discountCoverageRow(node, collectionId, protectedCollections)));
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return rows;
}
