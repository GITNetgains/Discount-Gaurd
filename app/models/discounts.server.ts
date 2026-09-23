import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

export const CONFIG_NAMESPACE = "$app";
export const CONFIG_KEY = "function-configuration";

export interface DiscountGuardConfiguration {
  percentage: number;
  message: string;
}

export interface DiscountFormValues {
  title: string;
  code: string;
  functionId: string;
  startsAt: string;
  endsAt: string | null;
  usageLimit: number | null;
  appliesOncePerCustomer: boolean;
  combinesWith: {
    orderDiscounts: boolean;
    productDiscounts: boolean;
    shippingDiscounts: boolean;
  };
  configuration: DiscountGuardConfiguration;
}

const CREATE_CODE_DISCOUNT = `#graphql
  mutation CreateCodeDiscount($codeAppDiscount: DiscountCodeAppInput!) {
    discountCodeAppCreate(codeAppDiscount: $codeAppDiscount) {
      codeAppDiscount {
        discountId
        title
        status
        codes(first: 1) {
          nodes { code }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const UPDATE_CODE_DISCOUNT = `#graphql
  mutation UpdateCodeDiscount($id: ID!, $codeAppDiscount: DiscountCodeAppInput!) {
    discountCodeAppUpdate(id: $id, codeAppDiscount: $codeAppDiscount) {
      codeAppDiscount {
        discountId
        title
        status
        codes(first: 1) {
          nodes { code }
        }
      }
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
        ... on DiscountCodeApp {
          title
          status
          combinesWith {
            orderDiscounts
            productDiscounts
            shippingDiscounts
          }
          codes(first: 1) {
            nodes { code }
          }
          startsAt
          endsAt
          usageLimit
          appliesOncePerCustomer
          appDiscountType {
            functionId
          }
        }
      }
      metafield(namespace: "${CONFIG_NAMESPACE}", key: "${CONFIG_KEY}") {
        id
        jsonValue
      }
    }
  }
`;

function toCodeAppDiscountInput(values: DiscountFormValues) {
  return {
    title: values.title,
    code: values.code,
    functionId: values.functionId,
    discountClasses: ["PRODUCT"],
    combinesWith: values.combinesWith,
    startsAt: values.startsAt,
    endsAt: values.endsAt,
    usageLimit: values.usageLimit,
    appliesOncePerCustomer: values.appliesOncePerCustomer,
    metafields: [
      {
        namespace: CONFIG_NAMESPACE,
        key: CONFIG_KEY,
        type: "json",
        value: JSON.stringify(values.configuration),
      },
    ],
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
  const response = await admin.graphql(CREATE_CODE_DISCOUNT, {
    variables: { codeAppDiscount: toCodeAppDiscountInput(values) },
  });
  const json = await response.json();
  assertNoTopLevelErrors(json);
  return json.data.discountCodeAppCreate;
}

export async function updateCodeDiscount(
  admin: AdminApiContext,
  discountId: string,
  values: DiscountFormValues,
) {
  const response = await admin.graphql(UPDATE_CODE_DISCOUNT, {
    variables: {
      id: discountId,
      codeAppDiscount: toCodeAppDiscountInput(values),
    },
  });
  const json = await response.json();
  assertNoTopLevelErrors(json);
  return json.data.discountCodeAppUpdate;
}

export interface DiscountCombinesWith {
  orderDiscounts: boolean;
  productDiscounts: boolean;
  shippingDiscounts: boolean;
}

export interface DiscountCodeAppNode {
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
    appDiscountType: { functionId: string };
  };
  metafield: { id: string; jsonValue: DiscountGuardConfiguration } | null;
}

export async function getDiscount(
  admin: AdminApiContext,
  discountId: string,
): Promise<DiscountCodeAppNode | null> {
  const response = await admin.graphql(GET_DISCOUNT, {
    variables: { id: discountId },
  });
  const json = await response.json();
  return json.data.discountNode;
}
