import { useEffect, useState } from "react";
import { redirect, useFetcher } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { createCodeDiscount } from "../models/discounts.server";

function fieldValue(event: Event) {
  return (event.target as HTMLInputElement).value;
}

function checkboxChecked(event: Event) {
  return (event.target as HTMLInputElement).checked;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { functionId: params.functionId as string };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const payload = JSON.parse(String(formData.get("discount")));

  try {
    const result = await createCodeDiscount(admin, {
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

    const discountId = result.codeAppDiscount.discountId as string;
    const numericId = discountId.split("/").pop();
    return redirect(`/app/discount/${params.functionId}/${numericId}`);
  } catch (error) {
    return {
      errors: [{ message: error instanceof Error ? error.message : String(error) }],
    };
  }
};

export default function NewDiscount() {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [title, setTitle] = useState("");
  const [code, setCode] = useState("");
  const [percentage, setPercentage] = useState("10");
  const [message, setMessage] = useState(
    "Promotional discount applied to eligible items only.",
  );
  const [usageLimit, setUsageLimit] = useState("");
  const [appliesOncePerCustomer, setAppliesOncePerCustomer] = useState(false);
  const [combinesWith, setCombinesWith] = useState({
    orderDiscounts: false,
    productDiscounts: false,
    shippingDiscounts: false,
  });

  const saving = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data && "errors" in fetcher.data && fetcher.data.errors?.length) {
      shopify.toast.show(fetcher.data.errors[0].message, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const handleSave = () => {
    if (!title || !code || !percentage) {
      shopify.toast.show("Title, code, and percentage are required", {
        isError: true,
      });
      return;
    }
    fetcher.submit(
      {
        discount: JSON.stringify({
          title,
          code,
          percentage,
          message,
          startsAt: new Date().toISOString(),
          endsAt: null,
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
    <s-page heading="Create Discount Guard code">
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
