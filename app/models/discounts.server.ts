import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { ensureEligibleCollection } from "./eligibility.server";

// Discount Guard codes are native Shopify "amount off products" code discounts
// scoped to the app-managed eligible-products collection, so they work on every
// Shopify plan (no Shopify Functions / Shopify Plus required).

export interface DiscountCombinesWith {
  orderDiscounts: boolean;
  productDiscounts: boolean;
  shippingDiscounts: boolean;
}

export interface DiscountFormValues {
  title: string;
  code: string;
  percentage: number;
  startsAt: string;
  endsAt: string | null;
  usageLimit: number | null;
  appliesOncePerCustomer: boolean;
  combinesWith: DiscountCombinesWith;
}

const CREATE_CODE_DISCOUNT = `#graphql
  mutation CreateCodeDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id }
      userErrors {
        field
        message
      }
    }
  }
`;

const UPDATE_CODE_DISCOUNT = `#graphql
  mutation UpdateCodeDiscount($id: ID!, $basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicUpdate(id: $id, basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id }
      userErrors {
        field
        message
      }
    }
  }
`;

const GET_DISCOUNT = `#graphql
  query GetDiscount($id: ID!) {
    discountNode(id: $id) {
      id
      discount {
        __typename
        ... on DiscountCodeBasic {
          title
          status
          startsAt
          endsAt
          usageLimit
          appliesOncePerCustomer
          combinesWith {
            orderDiscounts
            productDiscounts
            shippingDiscounts
          }
          codes(first: 1) {
            nodes { code }
          }
          customerGets {
            value {
              __typename
              ... on DiscountPercentage { percentage }
            }
          }
        }
      }
    }
  }
`;

function toBasicCodeDiscountInput(
  values: DiscountFormValues,
  collectionId?: string,
) {
  return {
    title: values.title,
    code: values.code,
    startsAt: values.startsAt,
    endsAt: values.endsAt,
    usageLimit: values.usageLimit,
    appliesOncePerCustomer: values.appliesOncePerCustomer,
    combinesWith: values.combinesWith,
    context: { all: "ALL" },
    customerGets: {
      // Shopify expects a fraction: 10% -> 0.1
      value: { percentage: values.percentage / 100 },
      ...(collectionId
        ? { items: { collections: { add: [collectionId] } } }
        : {}),
    },
  };
}

function assertNoTopLevelErrors(json: {
  data?: unknown;
  errors?: { message: string }[];
}) {
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  if (!json.data) {
    throw new Error("Admin API returned no data.");
  }
}

export async function createCodeDiscount(
  admin: AdminApiContext,
  values: DiscountFormValues,
) {
  // First code on this store builds the eligible collection from the catalog.
  const collection = await ensureEligibleCollection(admin);

  const response = await admin.graphql(CREATE_CODE_DISCOUNT, {
    variables: {
      basicCodeDiscount: toBasicCodeDiscountInput(values, collection.collectionId),
    },
  });
  const json = await response.json();
  assertNoTopLevelErrors(json);
  return json.data.discountCodeBasicCreate;
}

export async function updateCodeDiscount(
  admin: AdminApiContext,
  discountId: string,
  values: DiscountFormValues,
) {
  // Items are left untouched so the code stays scoped to the eligible collection.
  const response = await admin.graphql(UPDATE_CODE_DISCOUNT, {
    variables: {
      id: discountId,
      basicCodeDiscount: toBasicCodeDiscountInput(values),
    },
  });
  const json = await response.json();
  assertNoTopLevelErrors(json);
  return json.data.discountCodeBasicUpdate;
}

export interface DiscountCodeBasicNode {
  id: string;
  discount: {
    __typename: string;
    title: string;
    status: string;
    combinesWith: DiscountCombinesWith;
    codes: { nodes: { code: string }[] };
    startsAt: string;
    endsAt: string | null;
    usageLimit: number | null;
    appliesOncePerCustomer: boolean;
    customerGets: {
      value: { __typename: string; percentage?: number };
    };
  };
}

export async function getDiscount(
  admin: AdminApiContext,
  discountId: string,
): Promise<DiscountCodeBasicNode | null> {
  const response = await admin.graphql(GET_DISCOUNT, {
    variables: { id: discountId },
  });
  const json = await response.json();
  return json.data.discountNode;
}
