import { useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { findEligibleCollection } from "../models/eligibility.server";
import { getDiscountSettings } from "../models/discount-settings.server";
import { formatInZone, saleStatus } from "../lib/sale-calendar";
import type { action as resyncAction } from "./app.resync";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const [collection, protection, saleSettings, sales] = await Promise.all([
    findEligibleCollection(admin).catch(() => null),
    getDiscountSettings(shop),
    prisma.saleSettings.findUnique({ where: { shop } }),
    prisma.sale.findMany({
      where: { shop },
      orderBy: { position: "asc" },
      include: { _count: { select: { products: true } } },
    }),
  ]);

  const now = new Date();
  const rows = sales.map((sale) => {
    const startsAt = sale.startsAt?.toISOString() ?? null;
    const endsAt = sale.endsAt?.toISOString() ?? null;
    return {
      id: sale.id,
      name: sale.name,
      startsAt,
      endsAt,
      products: sale._count.products,
      status: saleStatus(startsAt, endsAt, now),
    };
  });
  const byStart = (a: { startsAt: string | null }, b: { startsAt: string | null }) =>
    (a.startsAt ?? "").localeCompare(b.startsAt ?? "");

  return {
    eligibleCollectionId: collection?.collectionId ?? null,
    protection,
    timezone: saleSettings?.timezone ?? "UTC",
    saleCollection: saleSettings?.collectionTitle ?? null,
    saleLastSyncAt: saleSettings?.lastSyncAt?.toISOString() ?? null,
    counts: {
      live: rows.filter((r) => r.status === "live").length,
      upcoming: rows.filter((r) => r.status === "upcoming").length,
      invalid: rows.filter((r) => r.status === "invalid").length,
    },
    live: rows.filter((r) => r.status === "live").sort(byStart).reverse().slice(0, 5),
    upcoming: rows.filter((r) => r.status === "upcoming").sort(byStart).slice(0, 5),
  };
};

type Tone = "info" | "success" | "neutral" | "critical" | "warning";

function StatTile({
  label,
  value,
  detail,
  tone,
  icon,
  href,
}: {
  label: string;
  value: string | number;
  detail: string;
  tone: Tone;
  icon: "shield-check-mark" | "collection" | "live" | "clock" | "alert-triangle" | "calendar";
  href: string;
}) {
  return (
    <s-clickable href={href} borderRadius="base" accessibilityLabel={`${label}: ${value}`}>
      <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="base" background="base">
        <s-stack direction="block" gap="small-200">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-icon type={icon} tone={tone === "warning" ? "caution" : tone} />
            <s-text color="subdued">{label}</s-text>
          </s-stack>
          <s-heading>{value}</s-heading>
          <s-text color="subdued">{detail}</s-text>
        </s-stack>
      </s-box>
    </s-clickable>
  );
}

function ToolCard({
  icon,
  title,
  description,
  badge,
  children,
}: {
  icon: "discount" | "calendar" | "product";
  title: string;
  description: string;
  badge?: { tone: Tone; label: string };
  children: React.ReactNode;
}) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="base" background="base">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small-200" alignItems="center" justifyContent="space-between">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-icon type={icon} />
            <s-heading>{title}</s-heading>
          </s-stack>
          {badge && <s-badge tone={badge.tone}>{badge.label}</s-badge>}
        </s-stack>
        <s-paragraph color="subdued">{description}</s-paragraph>
        <s-stack direction="inline" gap="small-200">{children}</s-stack>
      </s-stack>
    </s-box>
  );
}

export default function Index() {
  const {
    eligibleCollectionId,
    protection,
    timezone,
    saleCollection,
    saleLastSyncAt,
    counts,
    live,
    upcoming,
  } = useLoaderData<typeof loader>();
  const resync = useFetcher<typeof resyncAction>();
  const shopify = useAppBridge();
  const isResyncing = resync.state !== "idle";
  const protectionOn = protection.compareAtRule === "any";

  useEffect(() => {
    if (!resync.data) return;
    if ("error" in resync.data && resync.data.error) {
      shopify.toast.show(resync.data.error, { isError: true });
    } else if ("result" in resync.data && resync.data.result) {
      const { eligible, excluded } = resync.data.result;
      shopify.toast.show(`Resynced: ${eligible} eligible, ${excluded} excluded`);
    }
  }, [resync.data, shopify]);

  return (
    <s-page heading="Discount Guard">
      <s-button slot="primary-action" href="/app/discounts/new" variant="primary">
        Create discount code
      </s-button>
      <s-button slot="secondary-actions" href="/app/settings">
        Settings
      </s-button>

      {/* ---- Attention ---- */}
      {protection.lastSyncError && (
        <s-banner tone="critical" heading="Compare-at protection could not sync">
          {protection.lastSyncError}
          <s-button slot="secondary-actions" href="/app/settings">
            Review settings
          </s-button>
        </s-banner>
      )}
      {!eligibleCollectionId && (
        <s-banner tone="warning" heading="Eligible collection not set up yet">
          Create your first Discount Guard code and the app will build the
          eligible collection for you.
          <s-button slot="secondary-actions" href="/app/discounts/new">
            Create discount code
          </s-button>
        </s-banner>
      )}
      {counts.invalid > 0 && (
        <s-banner tone="warning" heading={`${counts.invalid} sale${counts.invalid === 1 ? "" : "s"} need dates`}>
          These sales will not go live until they have a valid start and end date.
          <s-button slot="secondary-actions" href="/app/sale-calendar">
            Fix in Sale Calendar
          </s-button>
        </s-banner>
      )}
      {resync.data && "result" in resync.data && resync.data.result && (
        <s-banner tone="success" heading="Eligible products resynced">
          {resync.data.result.eligible} eligible, {resync.data.result.excluded} excluded (
          {resync.data.result.added} added, {resync.data.result.removed} removed).
        </s-banner>
      )}

      {/* ---- Overview ---- */}
      <s-section>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base">
          <StatTile
            label="Compare-at protection"
            value={protectionOn ? "On" : "Off"}
            detail={
              protection.lastSyncAt
                ? `Synced ${formatInZone(protection.lastSyncAt, timezone)}`
                : "Not synced yet"
            }
            tone={protection.lastSyncError ? "critical" : protectionOn ? "success" : "neutral"}
            icon="shield-check-mark"
            href="/app/settings"
          />
          <StatTile
            label="Eligible collection"
            value={eligibleCollectionId ? "Ready" : "Not set up"}
            detail="Excludes MAP Restricted items"
            tone={eligibleCollectionId ? "success" : "warning"}
            icon="collection"
            href={eligibleCollectionId ? "/app/settings" : "/app/discounts/new"}
          />
          <StatTile
            label="Live sales"
            value={counts.live}
            detail={saleCollection ? `In ${saleCollection}` : "No collection chosen"}
            tone={counts.live ? "success" : "neutral"}
            icon="live"
            href="/app/sale-calendar"
          />
          <StatTile
            label="Upcoming sales"
            value={counts.upcoming}
            detail={
              upcoming[0]
                ? `Next: ${formatInZone(upcoming[0].startsAt, timezone)}`
                : "Nothing scheduled"
            }
            tone="info"
            icon="clock"
            href="/app/sale-calendar"
          />
        </s-grid>
      </s-section>

      {/* ---- Tools ---- */}
      <s-section heading="Tools">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))" gap="base">
          <ToolCard
            icon="discount"
            title="Discount codes"
            description="Native Shopify codes limited to products that follow your compare-at rule and are not MAP Restricted."
            badge={eligibleCollectionId ? { tone: "success", label: "Active" } : { tone: "warning", label: "Setup needed" }}
          >
            <s-button href="/app/discounts/new" variant="primary">
              Create code
            </s-button>
            {eligibleCollectionId && (
              <s-button
                onClick={() => resync.submit({}, { method: "POST", action: "/app/resync" })}
                {...(isResyncing ? { loading: true } : {})}
              >
                Resync products
              </s-button>
            )}
          </ToolCard>
          <ToolCard
            icon="calendar"
            title="Sale Calendar"
            description="Upload the sale sheet once. Products appear in the chosen collection on the start date and leave after the end date."
            badge={counts.live ? { tone: "success", label: `${counts.live} live` } : undefined}
          >
            <s-button href="/app/sale-calendar">Open Sale Calendar</s-button>
          </ToolCard>
          <ToolCard
            icon="product"
            title="Bulk tag products"
            description="Add or remove a tag, such as MAP Restricted, by vendor or on-sale status across the whole store."
          >
            <s-button href="/app/bulk-tag">Open Bulk tag</s-button>
          </ToolCard>
        </s-grid>
      </s-section>

      {/* ---- Sales at a glance ---- */}
      <s-section heading="Sales at a glance">
        {live.length + upcoming.length === 0 ? (
          <s-box padding="large-200">
            <s-stack direction="block" gap="small-200" alignItems="center">
              <s-icon type="calendar" tone="neutral" />
              <s-text color="subdued">No live or upcoming sales.</s-text>
              <s-button href="/app/sale-calendar">Upload a sale sheet</s-button>
            </s-stack>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Sale</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Starts</s-table-header>
              <s-table-header>Ends</s-table-header>
              <s-table-header format="numeric">Products</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {[...live, ...upcoming].map((sale) => (
                <s-table-row key={sale.id}>
                  <s-table-cell>{sale.name}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={sale.status === "live" ? "success" : "info"}>
                      {sale.status === "live" ? "Live" : "Upcoming"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{formatInZone(sale.startsAt, timezone)}</s-table-cell>
                  <s-table-cell>{formatInZone(sale.endsAt, timezone)}</s-table-cell>
                  <s-table-cell>{sale.products}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      {/* ---- Side panel ---- */}
      <s-section slot="aside" heading="How it works">
        <s-stack direction="block" gap="small-200">
          <s-paragraph>
            Codes apply only to the hidden &quot;Discount Guard – Eligible&quot;
            collection, which updates automatically when products change.
          </s-paragraph>
          <s-paragraph color="subdued">
            Do not edit or delete that collection.
          </s-paragraph>
        </s-stack>
      </s-section>
      <s-section slot="aside" heading="Sale Calendar sync">
        <s-paragraph color="subdued">
          {saleLastSyncAt
            ? `Last run ${formatInZone(saleLastSyncAt, timezone)}`
            : "Has not run yet"}
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
