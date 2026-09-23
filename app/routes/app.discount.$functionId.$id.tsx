import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getDiscount, updateCodeDiscount } from "../models/discounts.server";

function fieldValue(event: Event) {
  return (event.target as HTMLInputElement).value;
}

function checkboxChecked(event: Event) {
  return (event.target as HTMLInputElement).checked;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const discountId = `gid://shopify/DiscountCodeNode/${params.id}`;
  const discountNode = await getDiscount(admin, discountId);

  if (!discountNode || discountNode.discount.__typename !== "DiscountCodeApp") {
    throw new Response("Discount not found", { status: 404 });
  }

  const configuration = discountNode.metafield?.jsonValue ?? {
    percentage: 0,
    message: "",
  };

  return {
    discountId,
    discount: discountNode.discount,
    configuration,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const payload = JSON.parse(String(formData.get("discount")));
  const discountId = `gid://shopify/DiscountCodeNode/${params.id}`;

  try {
    const result = await updateCodeDiscount(admin, discountId, {
      title: payload.title,
      code: payload.code,
      functionId: params.functionId as string,
      startsAt: payload.startsAt,
      endsAt: payload.endsAt || null,
      usageLimit: payload.usageLimit ? Number(payload.usageLimit) : null,
      appliesOncePerCustomer: Boolean(payload.appliesOncePerCustomer),
      combinesWith: payload.combinesWith,
      configuration: {
        percentage: Number(payload.percentage),
        message: payload.message ?? "",
      },
    });

    if (result.userErrors.length > 0) {
      return { errors: result.userErrors };
    }

    return { success: true };
  } catch (error) {
    return {
      errors: [{ message: error instanceof Error ? error.message : String(error) }],
    };
  }
};

export default function EditDiscount() {
  const { discount, configuration } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [title, setTitle] = useState(discount.title);
  const [code, setCode] = useState(discount.codes.nodes[0]?.code ?? "");
  const [percentage, setPercentage] = useState(String(configuration.percentage ?? 0));
  const [message, setMessage] = useState(configuration.message ?? "");
  const [usageLimit, setUsageLimit] = useState(
    discount.usageLimit ? String(discount.usageLimit) : "",
  );
  const [appliesOncePerCustomer, setAppliesOncePerCustomer] = useState(
    Boolean(discount.appliesOncePerCustomer),
  );
  const [combinesWith, setCombinesWith] = useState(discount.combinesWith);

  const saving = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data && "errors" in fetcher.data && fetcher.data.errors?.length) {
      shopify.toast.show(fetcher.data.errors[0].message, { isError: true });
    } else if (fetcher.data && "success" in fetcher.data) {
      shopify.toast.show("Discount saved");
    }
  }, [fetcher.data, shopify]);

  const handleSave = () => {
    fetcher.submit(
      {
        discount: JSON.stringify({
          title,
          code,
          percentage,
          message,
          startsAt: discount.startsAt,
          endsAt: discount.endsAt,
          usageLimit: usageLimit || null,
          appliesOncePerCustomer,
          combinesWith,
        }),
      },
      { method: "post" },
    );
  };

  const errors =
    fetcher.data && "errors" in fetcher.data ? fetcher.data.errors ?? [] : [];

  return (
    <s-page heading="Discount Guard code">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>
      <s-button
        slot="primary-action"
        onClick={handleSave}
        {...(saving ? { loading: true } : {})}
      >
        Save discount
      </s-button>

      {errors.length > 0 && (
        <s-banner tone="critical" heading="There were problems saving this discount">
          <s-unordered-list>
            {errors.map((error: { message: string }, index: number) => (
              <s-list-item key={index}>{error.message}</s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      )}

      <s-section heading="Discount details">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Title (internal)"
            value={title}
            onChange={(e: Event) => setTitle(fieldValue(e))}
          />
          <s-text-field
            label="Discount code"
            value={code}
            onChange={(e: Event) => setCode(fieldValue(e).toUpperCase())}
          />
          <s-paragraph>Status: {discount.status}</s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Discount Guard configuration">
        <s-stack direction="block" gap="base">
          <s-number-field
            label="Percentage off eligible items"
            suffix="%"
            min={0}
            max={100}
            value={percentage}
            onChange={(e: Event) => setPercentage(fieldValue(e))}
          />
          <s-text-field
            label="Cart/checkout message"
            value={message}
            onChange={(e: Event) => setMessage(fieldValue(e))}
            details="Shown to customers next to eligible line items."
          />
          <s-paragraph>
            Sale-priced items (compare-at price greater than current price)
            and MAP Restricted products are automatically excluded — no
            configuration needed.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Usage limits">
        <s-stack direction="block" gap="base">
          <s-number-field
            label="Total usage limit"
            value={usageLimit}
            onChange={(e: Event) => setUsageLimit(fieldValue(e))}
            details="Leave blank for unlimited uses."
          />
          <s-checkbox
            label="Limit to one use per customer"
            checked={appliesOncePerCustomer}
            onChange={(e: Event) => setAppliesOncePerCustomer(checkboxChecked(e))}
          />
        </s-stack>
      </s-section>

      <s-section heading="Combine with other discounts">
        <s-stack direction="block" gap="base">
          <s-checkbox
            label="Product discounts"
            checked={combinesWith.productDiscounts}
            onChange={(e: Event) =>
              setCombinesWith((prev) => ({
                ...prev,
                productDiscounts: checkboxChecked(e),
              }))
            }
          />
          <s-checkbox
            label="Order discounts"
            checked={combinesWith.orderDiscounts}
            onChange={(e: Event) =>
              setCombinesWith((prev) => ({
                ...prev,
                orderDiscounts: checkboxChecked(e),
              }))
            }
          />
          <s-checkbox
            label="Shipping discounts"
            checked={combinesWith.shippingDiscounts}
            onChange={(e: Event) =>
              setCombinesWith((prev) => ({
                ...prev,
                shippingDiscounts: checkboxChecked(e),
              }))
            }
          />
        </s-stack>
      </s-section>
    </s-page>
  );
}
