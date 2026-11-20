import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  detachCollection,
  getSettings,
  listSales,
  log,
  parseSaleWorkbook,
  refreshTimezone,
  replaceSales,
  scanCatalogChunk,
  syncShop,
  type ParsedSale,
  type SaleToSave,
} from "../models/sale-calendar.server";
import {
  buildCatalogIndex,
  dateProblem,
  formatInZone,
  matchProduct,
  parseSheetDate,
  saleStatus,
  toInputValue,
  zonedToUtc,
  type CatalogRow,
  type SaleStatus,
} from "../lib/sale-calendar";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  await getSettings(shop);
  const timezone = await refreshTimezone(admin, shop).catch(async () => (await getSettings(shop)).timezone);
  const settings = await getSettings(shop);
  const [sales, logs] = await Promise.all([
    listSales(shop),
    prisma.saleSyncLog.findMany({ where: { shop }, orderBy: { at: "desc" }, take: 20 }),
  ]);
  return {
    timezone,
    settings: {
      collectionId: settings.collectionId,
      collectionTitle: settings.collectionTitle,
      reorder: settings.reorder,
      lastSyncAt: settings.lastSyncAt?.toISOString() ?? null,
      lastSyncMessage: settings.lastSyncMessage,
    },
    sales,
    logs: logs.map((l) => ({ id: l.id, at: l.at.toISOString(), message: l.message })),
  };
};

async function syncAfterChange(admin: Parameters<typeof syncShop>[0], shop: string) {
  try {
    return (await syncShop(admin, shop)).message;
  } catch (error) {
    return `Sync failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  try {
    if (intent === "parse") {
      const file = formData.get("file");
      if (!(file instanceof File) || !file.size) return { intent, error: "Choose an .xlsx file." };
      if (file.size > MAX_UPLOAD_BYTES) return { intent, error: "File is larger than 10 MB." };
      const timezone = (await getSettings(shop)).timezone;
      const sales = parseSaleWorkbook(Buffer.from(await file.arrayBuffer()), timezone);
      if (!sales.length) return { intent, error: "No sales found in the sheet." };
      return { intent, sales, fileName: file.name };
    }

    if (intent === "scan") {
      const cursor = String(formData.get("cursor") ?? "") || null;
      return { intent, ...(await scanCatalogChunk(admin, cursor)) };
    }

    if (intent === "save") {
      const sales: SaleToSave[] = JSON.parse(String(formData.get("sales") ?? "[]"));
      await replaceSales(shop, sales);
      await log(shop, `Uploaded sheet with ${sales.length} sales.`);
      return { intent, ok: true, message: await syncAfterChange(admin, shop) };
    }

    if (intent === "setCollection") {
      const collectionId = String(formData.get("collectionId") ?? "");
      const collectionTitle = String(formData.get("collectionTitle") ?? "");
      if (!collectionId) return { intent, error: "Choose a collection." };
      const settings = await getSettings(shop);
      if (settings.collectionId && settings.collectionId !== collectionId) {
        await detachCollection(admin, shop);
      }
      await prisma.saleSettings.update({
        where: { shop },
        data: { collectionId, collectionTitle, needsReorder: true },
      });
      await log(shop, `Collection set to "${collectionTitle}".`);
      return { intent, ok: true, message: await syncAfterChange(admin, shop) };
    }

    if (intent === "setReorder") {
      const reorder = formData.get("reorder") === "true";
      await prisma.saleSettings.update({
        where: { shop },
        data: { reorder, needsReorder: reorder },
      });
      return { intent, ok: true, message: await syncAfterChange(admin, shop) };
    }

    if (intent === "updateDates") {
      const id = Number(formData.get("id"));
      const timezone = (await getSettings(shop)).timezone;
      const toDate = (value: FormDataEntryValue | null) => {
        const wall = parseSheetDate(String(value ?? ""));
        return wall ? zonedToUtc(wall, timezone) : null;
      };
      const startsAt = toDate(formData.get("startsAt"));
      const endsAt = toDate(formData.get("endsAt"));
      const problem = dateProblem(startsAt?.toISOString() ?? null, endsAt?.toISOString() ?? null);
      if (problem) return { intent, error: problem };
      const name = String(formData.get("name") ?? "").replace(/\s+/g, " ").trim();
      if (!name) return { intent, error: "Enter a sale name." };
      if (name.length > 120) return { intent, error: "Sale name is too long (max 120 characters)." };
      const sale = await prisma.sale.findFirst({ where: { id, shop } });
      if (!sale) return { intent, error: "Sale not found." };
      await prisma.sale.update({ where: { id }, data: { name, startsAt, endsAt } });
      if (name !== sale.name) await log(shop, `Renamed sale "${sale.name}" to "${name}".`);
      const datesChanged =
        sale.startsAt?.getTime() !== startsAt?.getTime() || sale.endsAt?.getTime() !== endsAt?.getTime();
      if (datesChanged) {
        await log(
          shop,
          `Dates changed for "${name}": ${formatInZone(startsAt!.toISOString(), timezone)} – ${formatInZone(endsAt!.toISOString(), timezone)}.`,
        );
      }
      return { intent, ok: true, message: await syncAfterChange(admin, shop) };
    }

    if (intent === "deleteSale") {
      const id = Number(formData.get("id"));
      const sale = await prisma.sale.findFirst({ where: { id, shop } });
      if (!sale) return { intent, error: "Sale not found." };
      await prisma.sale.delete({ where: { id } });
      await log(shop, `Deleted sale "${sale.name}".`);
      return { intent, ok: true, message: await syncAfterChange(admin, shop) };
    }

    if (intent === "sync") {
      return { intent, ok: true, message: (await syncShop(admin, shop)).message };
    }

    return { intent, error: "Unknown action." };
  } catch (error) {
    return { intent, error: error instanceof Error ? error.message : String(error) };
  }
};

type ActionData = {
  intent: string;
  error?: string;
  ok?: boolean;
  message?: string;
  sales?: ParsedSale[];
  fileName?: string;
  rows?: CatalogRow[];
  nextCursor?: string | null;
};

const STATUS_LABEL: Record<SaleStatus, string> = {
  upcoming: "Upcoming",
  live: "Live",
  ended: "Ended",
  invalid: "Fix dates",
};

const STATUS_TONE: Record<SaleStatus, "info" | "success" | "neutral" | "critical"> = {
  upcoming: "info",
  live: "success",
  ended: "neutral",
  invalid: "critical",
};

const STATUS_ICON: Record<SaleStatus, "clock" | "live" | "check-circle" | "alert-triangle"> = {
  upcoming: "clock",
  live: "live",
  ended: "check-circle",
  invalid: "alert-triangle",
};

// Display order: what needs attention first.
const STATUS_RANK: Record<SaleStatus, number> = { live: 0, invalid: 1, upcoming: 2, ended: 3 };

type Filter = "all" | SaleStatus;

function relative(iso: string, now: number) {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const days = Math.floor(abs / 86400000);
  const hours = Math.floor((abs % 86400000) / 3600000);
  const minutes = Math.floor((abs % 3600000) / 60000);
  const text = days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

/** "Nov 13, 11:30 AM" (year only when it is not the current year). */
function shortDate(iso: string | null, timeZone: string) {
  if (!iso) return null;
  const date = new Date(iso);
  const sameYear =
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(date) ===
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(new Date());
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

const inputStyle = {
  width: "100%",
  boxSizing: "border-box" as const,
  padding: "8px 10px",
  border: "1px solid var(--p-color-border, #8a8a8a)",
  borderRadius: "8px",
  font: "inherit",
};

type Overlay = HTMLElement & { showOverlay: () => void; hideOverlay: () => void };
const overlay = (id: string) => document.getElementById(id) as Overlay | null;

function StatTile({
  label,
  value,
  tone,
  icon,
  active,
  onClick,
}: {
  label: string;
  value: number;
  tone: "info" | "success" | "neutral" | "critical";
  icon: "clock" | "live" | "check-circle" | "alert-triangle" | "calendar";
  active: boolean;
  onClick: () => void;
}) {
  return (
    <s-clickable onClick={onClick} borderRadius="base" accessibilityLabel={`Show ${label}`}>
      <s-box
        padding="base"
        borderWidth="base"
        borderRadius="base"
        borderColor={active ? "strong" : "base"}
        background={active ? "subdued" : "base"}
      >
        <s-stack direction="block" gap="small-200">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-icon type={icon} tone={tone} />
            <s-text color="subdued">{label}</s-text>
          </s-stack>
          <s-heading>{value}</s-heading>
        </s-stack>
      </s-box>
    </s-clickable>
  );
}

export default function SaleCalendar() {
  const { timezone, settings, sales, logs } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();

  const mutate = useFetcher<ActionData>();
  const parseFetcher = useFetcher<ActionData>();
  const scanFetcher = useFetcher<ActionData>();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // Refresh statuses from the server every minute (background sync may change them).
  useEffect(() => {
    const t = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 60000);
    return () => clearInterval(t);
  }, [revalidator]);

  // ---- Generic mutations ----
  const lastMutate = useRef<ActionData | undefined>(undefined);
  useEffect(() => {
    const data = mutate.data;
    if (mutate.state !== "idle" || !data || data === lastMutate.current) return;
    lastMutate.current = data;
    if (data.error) {
      shopify.toast.show(data.error, { isError: true });
      return;
    }
    if (data.message) shopify.toast.show(data.message);
    if (data.intent === "updateDates") overlay("edit-dates-modal")?.hideOverlay();
    if (data.intent === "deleteSale") overlay("delete-modal")?.hideOverlay();
    if (data.intent === "save") {
      setParsed(null);
      setCatalog(null);
    }
  }, [mutate.state, mutate.data, shopify]);
  const busy = mutate.state !== "idle";
  const busyIntent = busy ? String(mutate.formData?.get("intent") ?? "") : "";

  const submit = (data: Record<string, string>) => mutate.submit(data, { method: "post" });

  // ---- Collection ----
  const chooseCollection = async () => {
    const picked = await shopify.resourcePicker({ type: "collection", action: "select" });
    const collection = picked?.[0] as { id: string; title: string } | undefined;
    if (!collection) return;
    submit({
      intent: "setCollection",
      collectionId: collection.id,
      collectionTitle: collection.title,
    });
  };

  // ---- Upload: parse sheet, then scan catalog and match names ----
  const [parsed, setParsed] = useState<{ sales: ParsedSale[]; fileName: string } | null>(null);
  const [catalog, setCatalog] = useState<CatalogRow[] | null>(null);
  const [scanCount, setScanCount] = useState<number | null>(null);
  const rowsRef = useRef<CatalogRow[]>([]);
  const lastParse = useRef<ActionData | undefined>(undefined);
  const lastScan = useRef<ActionData | undefined>(undefined);

  const readSheet = (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      shopify.toast.show("Upload an .xlsx file", { isError: true });
      return;
    }
    const form = new FormData();
    form.append("intent", "parse");
    form.append("file", file);
    setParsed(null);
    setCatalog(null);
    parseFetcher.submit(form, { method: "post", encType: "multipart/form-data" });
  };

  useEffect(() => {
    const data = parseFetcher.data;
    if (parseFetcher.state !== "idle" || !data || data === lastParse.current) return;
    lastParse.current = data;
    if (data.error) {
      shopify.toast.show(data.error, { isError: true });
      return;
    }
    setParsed({ sales: data.sales ?? [], fileName: data.fileName ?? "" });
    rowsRef.current = [];
    setScanCount(0);
    scanFetcher.submit({ intent: "scan", cursor: "" }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parseFetcher.state, parseFetcher.data]);

  useEffect(() => {
    const data = scanFetcher.data;
    if (scanFetcher.state !== "idle" || !data || data === lastScan.current) return;
    lastScan.current = data;
    if (data.error) {
      setScanCount(null);
      shopify.toast.show(data.error, { isError: true });
      return;
    }
    rowsRef.current.push(...(data.rows ?? []));
    setScanCount(rowsRef.current.length);
    if (data.nextCursor) {
      scanFetcher.submit({ intent: "scan", cursor: data.nextCursor }, { method: "post" });
    } else {
      setCatalog(rowsRef.current);
      setScanCount(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanFetcher.state, scanFetcher.data]);

  const preview = useMemo(() => {
    if (!parsed || !catalog) return null;
    const index = buildCatalogIndex(catalog);
    return parsed.sales.map((sale) => {
      const products: { id: string; title: string }[] = [];
      const seen = new Set<string>();
      const unmatched: string[] = [];
      for (const item of sale.items) {
        const id = matchProduct(index, item.name, item.productId);
        if (!id) {
          unmatched.push(item.name || item.productId || "");
        } else if (!seen.has(id)) {
          seen.add(id);
          products.push({ id, title: index.titles.get(id) ?? item.name });
        }
      }
      return { ...sale, products, unmatched, matchedRows: sale.items.length - unmatched.length };
    });
  }, [parsed, catalog]);

  const saveSales = () => {
    if (!preview) return;
    const payload: SaleToSave[] = preview.map((s) => ({
      name: s.name,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      tab: s.tab,
      products: s.products,
      unmatched: s.unmatched,
    }));
    submit({ intent: "save", sales: JSON.stringify(payload) });
  };

  // ---- Sales list ----
  const [filter, setFilter] = useState<Filter>("all");
  const withStatus = useMemo(
    () =>
      sales
        .map((s) => ({ ...s, status: saleStatus(s.startsAt, s.endsAt, new Date(now)) }))
        .sort(
          (a, b) =>
            STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
            (a.status === "live"
              ? new Date(a.endsAt!).getTime() - new Date(b.endsAt!).getTime()
              : a.status === "ended"
                ? new Date(b.endsAt!).getTime() - new Date(a.endsAt!).getTime()
                : new Date(a.startsAt ?? 0).getTime() - new Date(b.startsAt ?? 0).getTime()),
        ),
    [sales, now],
  );
  const counts = withStatus.reduce(
    (acc, s) => ({ ...acc, [s.status]: acc[s.status] + 1 }),
    { upcoming: 0, live: 0, ended: 0, invalid: 0 } as Record<SaleStatus, number>,
  );
  const visible = filter === "all" ? withStatus : withStatus.filter((s) => s.status === filter);
  const liveProducts = new Set(
    withStatus.filter((s) => s.status === "live").flatMap((s) => s.products.map((p) => p.id)),
  ).size;

  // ---- Modals ----
  const [editing, setEditing] = useState<{
    id: number;
    name: string;
    startsAt: string;
    endsAt: string;
  } | null>(null);
  const [viewing, setViewing] = useState<(typeof sales)[number] | null>(null);
  const [deleting, setDeleting] = useState<{ id: number; name: string } | null>(null);

  const openEdit = (s: (typeof sales)[number]) => {
    setEditing({
      id: s.id,
      name: s.name,
      startsAt: toInputValue(s.startsAt, timezone),
      endsAt: toInputValue(s.endsAt, timezone),
    });
    overlay("edit-dates-modal")?.showOverlay();
  };

  const editProblem = editing
    ? dateProblem(
        editing.startsAt ? new Date(editing.startsAt).toISOString() : null,
        editing.endsAt ? new Date(editing.endsAt).toISOString() : null,
      )
    : null;
  const nameProblem = editing && !editing.name.trim() ? "Enter a sale name." : null;

  const scanning = scanCount !== null;
  const reading = parseFetcher.state !== "idle";
  const noCollection = !settings.collectionId;
  const lastSyncFailed = settings.lastSyncMessage?.startsWith("Sync failed");

  return (
    <s-page heading="Sale Calendar">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>
      <s-button
        slot="primary-action"
        onClick={() => submit({ intent: "sync" })}
        disabled={noCollection || (busy && busyIntent !== "sync")}
        {...(busyIntent === "sync" ? { loading: true } : {})}
      >
        Sync now
      </s-button>

      {noCollection && (
        <s-banner tone="warning" heading="Choose a collection to start">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Sales are saved, but no products are added anywhere until you pick the
              collection the sale products should appear in.
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <s-button variant="primary" onClick={chooseCollection} disabled={busy}>
                Choose collection
              </s-button>
            </s-stack>
          </s-stack>
        </s-banner>
      )}
      {!noCollection && lastSyncFailed && (
        <s-banner tone="critical" heading="Last sync failed">
          {settings.lastSyncMessage}
        </s-banner>
      )}

      {/* ---- Overview ---- */}
      <s-section>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))" gap="base">
          <StatTile
            label="Live now"
            value={counts.live}
            tone="success"
            icon="live"
            active={filter === "live"}
            onClick={() => setFilter(filter === "live" ? "all" : "live")}
          />
          <StatTile
            label="Upcoming"
            value={counts.upcoming}
            tone="info"
            icon="clock"
            active={filter === "upcoming"}
            onClick={() => setFilter(filter === "upcoming" ? "all" : "upcoming")}
          />
          <StatTile
            label="Need dates"
            value={counts.invalid}
            tone="critical"
            icon="alert-triangle"
            active={filter === "invalid"}
            onClick={() => setFilter(filter === "invalid" ? "all" : "invalid")}
          />
          <StatTile
            label="Ended"
            value={counts.ended}
            tone="neutral"
            icon="check-circle"
            active={filter === "ended"}
            onClick={() => setFilter(filter === "ended" ? "all" : "ended")}
          />
        </s-grid>
      </s-section>

      {/* ---- Sales ---- */}
      <s-section heading={filter === "all" ? "Sales" : `Sales — ${STATUS_LABEL[filter]}`}>
        <s-stack direction="block" gap="base">
          {sales.length === 0 ? (
            <s-box padding="large-200">
              <s-stack direction="block" gap="small-200" alignItems="center">
                <s-icon type="calendar" />
                <s-heading>No sales yet</s-heading>
                <s-text color="subdued">Upload the sale sheet below to get started.</s-text>
              </s-stack>
            </s-box>
          ) : (
            <>
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-text color="subdued">
                  {visible.length} of {sales.length} sales · {liveProducts} products in the
                  collection now · times in {timezone}
                </s-text>
                {filter !== "all" && (
                  <s-button variant="tertiary" onClick={() => setFilter("all")}>
                    Show all
                  </s-button>
                )}
              </s-stack>
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Sale</s-table-header>
                  <s-table-header listSlot="secondary">Status</s-table-header>
                  <s-table-header>Schedule</s-table-header>
                  <s-table-header format="numeric">Products</s-table-header>
                  <s-table-header>Actions</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {visible.map((s) => {
                    const when =
                      s.status === "upcoming"
                        ? `Starts ${relative(s.startsAt!, now)}`
                        : s.status === "live"
                          ? `Ends ${relative(s.endsAt!, now)}`
                          : s.status === "ended"
                            ? `Ended ${relative(s.endsAt!, now)}`
                            : dateProblem(s.startsAt, s.endsAt);
                    return (
                      <s-table-row key={s.id}>
                        <s-table-cell>
                          <s-stack direction="block" gap="small-300">
                            <s-text type="strong">{s.name}</s-text>
                            {s.tab && <s-text color="subdued">Tab: {s.tab.trim()}</s-text>}
                          </s-stack>
                        </s-table-cell>
                        <s-table-cell>
                          <s-stack direction="block" gap="small-300">
                            <s-badge tone={STATUS_TONE[s.status]} icon={STATUS_ICON[s.status]}>
                              {STATUS_LABEL[s.status]}
                            </s-badge>
                            <s-text color="subdued">{when}</s-text>
                          </s-stack>
                        </s-table-cell>
                        <s-table-cell>
                          <s-stack direction="block" gap="small-300">
                            <s-text>
                              {shortDate(s.startsAt, timezone) ?? (
                                <s-text tone="critical">No start date</s-text>
                              )}
                            </s-text>
                            <s-text color="subdued">
                              to{" "}
                              {shortDate(s.endsAt, timezone) ?? (
                                <s-text tone="critical">no end date</s-text>
                              )}
                            </s-text>
                          </s-stack>
                        </s-table-cell>
                        <s-table-cell>
                          <s-stack direction="block" gap="small-300">
                            <s-text>{s.products.length}</s-text>
                            {s.unmatched.length > 0 && (
                              <s-text tone="critical">{s.unmatched.length} not found</s-text>
                            )}
                          </s-stack>
                        </s-table-cell>
                        <s-table-cell>
                          <s-button-group gap="none">
                            <s-button
                              slot="secondary-actions"
                              icon="calendar-time"
                              disabled={busy}
                              onClick={() => openEdit(s)}
                            >
                              Edit
                            </s-button>
                            <s-button
                              slot="secondary-actions"
                              icon="view"
                              accessibilityLabel={`View products of ${s.name}`}
                              onClick={() => {
                                setViewing(s);
                                overlay("products-modal")?.showOverlay();
                              }}
                            />
                            <s-button
                              slot="secondary-actions"
                              icon="delete"
                              tone="critical"
                              accessibilityLabel={`Delete ${s.name}`}
                              disabled={busy}
                              onClick={() => {
                                setDeleting({ id: s.id, name: s.name });
                                overlay("delete-modal")?.showOverlay();
                              }}
                            />
                          </s-button-group>
                        </s-table-cell>
                      </s-table-row>
                    );
                  })}
                </s-table-body>
              </s-table>
              {visible.length === 0 && (
                <s-text color="subdued">No sales with this status.</s-text>
              )}
            </>
          )}
        </s-stack>
      </s-section>

      {/* ---- Upload ---- */}
      <s-section heading={sales.length ? "Replace sale sheet" : "Upload sale sheet"}>
        <s-stack direction="block" gap="base">
          <s-drop-zone
            label="Sale sheet (.xlsx)"
            accept=".xlsx"
            accessibilityLabel="Upload sale sheet"
            disabled={busy || scanning || reading}
            onChange={(e: Event) =>
              readSheet((e.currentTarget as unknown as { files: readonly File[] }).files?.[0])
            }
          />
          <s-text color="subdued">
            Needs a tab with Sale name, Start Date, End Date and a &quot;Products&quot; link
            to each sale&apos;s tab. Dates are read in {timezone}. Saving replaces all
            current sales.
          </s-text>

          {(reading || scanning) && (
            <s-banner tone="info">
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-spinner size="base" accessibilityLabel="Working" />
                <s-text>
                  {reading
                    ? "Reading sheet…"
                    : `Matching products with your store… ${scanCount} variants checked`}
                </s-text>
              </s-stack>
            </s-banner>
          )}

          {preview && (
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-icon type="file" />
                  <s-heading>Preview: {parsed?.fileName}</s-heading>
                </s-stack>
                <s-text>
                  {preview.length} sales ·{" "}
                  {preview.reduce((n, s) => n + s.products.length, 0)} products ·{" "}
                  {preview.reduce((n, s) => n + s.unmatched.length, 0)} names not found ·{" "}
                  {preview.filter((s) => s.problems.length).length} with date problems
                </s-text>
                <s-table>
                  <s-table-header-row>
                    <s-table-header listSlot="primary">Sale</s-table-header>
                    <s-table-header>Schedule</s-table-header>
                    <s-table-header format="numeric">Products</s-table-header>
                    <s-table-header>Check</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {preview.map((s, i) => {
                      const issues = [
                        ...s.problems,
                        ...(s.unmatched.length ? [`${s.unmatched.length} names not found`] : []),
                      ];
                      return (
                        <s-table-row key={i}>
                          <s-table-cell>{s.name}</s-table-cell>
                          <s-table-cell>
                            {shortDate(s.startsAt, timezone) ?? "—"} →{" "}
                            {shortDate(s.endsAt, timezone) ?? "—"}
                          </s-table-cell>
                          <s-table-cell>
                            {s.products.length} ({s.matchedRows}/{s.items.length} rows)
                          </s-table-cell>
                          <s-table-cell>
                            {issues.length ? (
                              <s-badge tone="warning">{issues.join("; ")}</s-badge>
                            ) : (
                              <s-badge tone="success">OK</s-badge>
                            )}
                          </s-table-cell>
                        </s-table-row>
                      );
                    })}
                  </s-table-body>
                </s-table>
                {preview.some((s) => s.unmatched.length) && (
                  <details>
                    <summary>Show names not found in the store</summary>
                    <ul>
                      {preview.flatMap((s) =>
                        s.unmatched.map((n, i) => (
                          <li key={`${s.name}-${i}`}>
                            {s.name}: {n}
                          </li>
                        )),
                      )}
                    </ul>
                  </details>
                )}
                {preview.some((s) => s.problems.length) && (
                  <s-text color="subdued">
                    Sales with date problems are saved but never run until their dates are
                    fixed with &quot;Edit&quot;.
                  </s-text>
                )}
                <s-stack direction="inline" gap="base">
                  <s-button
                    variant="primary"
                    onClick={saveSales}
                    disabled={busy && busyIntent !== "save"}
                    {...(busyIntent === "save" ? { loading: true } : {})}
                  >
                    Save {preview.length} sales
                  </s-button>
                  <s-button
                    onClick={() => {
                      setParsed(null);
                      setCatalog(null);
                    }}
                  >
                    Cancel
                  </s-button>
                </s-stack>
              </s-stack>
            </s-box>
          )}
        </s-stack>
      </s-section>

      {/* ---- Aside: collection ---- */}
      <s-section slot="aside" heading="Collection">
        <s-stack direction="block" gap="base">
          {noCollection ? (
            <s-badge tone="warning" icon="alert-triangle">
              Not selected
            </s-badge>
          ) : (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-icon type="collection" />
              <s-text type="strong">{settings.collectionTitle}</s-text>
            </s-stack>
          )}
          <s-text color="subdued">
            Live sale products are added here and removed after the sale ends. Products you
            add to this collection yourself always stay.
          </s-text>
          <s-button
            onClick={chooseCollection}
            disabled={busy}
            {...(noCollection ? { variant: "primary" as const } : {})}
          >
            {noCollection ? "Choose collection" : "Change collection"}
          </s-button>
          <s-divider />
          <s-switch
            label="Sale order"
            details="Show the first sale's products first, then the next sale's. Sets the collection sort to Manual."
            checked={settings.reorder}
            disabled={busy}
            onChange={(e: Event) =>
              submit({
                intent: "setReorder",
                reorder: String((e.target as HTMLInputElement).checked),
              })
            }
          />
        </s-stack>
      </s-section>

      {/* ---- Aside: activity ---- */}
      <s-section slot="aside" heading="Activity">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-icon type="refresh" tone={lastSyncFailed ? "critical" : "success"} />
            <s-text color="subdued">
              Checks every 5 minutes.{" "}
              {settings.lastSyncAt
                ? `Last: ${shortDate(settings.lastSyncAt, timezone)}`
                : "Not run yet."}
            </s-text>
          </s-stack>
          {logs.length === 0 ? (
            <s-text color="subdued">No activity yet.</s-text>
          ) : (
            <s-stack direction="block" gap="small-200">
              {logs.slice(0, 8).map((l) => (
                <s-box key={l.id} paddingBlockEnd="small-200">
                  <s-stack direction="block" gap="small-400">
                    <s-text color="subdued">{shortDate(l.at, timezone)}</s-text>
                    <s-text>{l.message}</s-text>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {/* ---- Modals ---- */}
      <s-modal id="edit-dates-modal" heading="Edit sale">
        {editing && (
          <s-stack direction="block" gap="base">
            <s-stack direction="block" gap="small-300">
              <label htmlFor="sale-name" style={{ fontWeight: 600 }}>
                Sale name
              </label>
              <input
                id="sale-name"
                type="text"
                maxLength={120}
                style={inputStyle}
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
              <s-text color="subdued">Shown as the heading above this sale&apos;s products in the store.</s-text>
            </s-stack>
            <s-stack direction="block" gap="small-300">
              <label htmlFor="sale-starts-at" style={{ fontWeight: 600 }}>
                Start
              </label>
              <input
                id="sale-starts-at"
                type="datetime-local"
                style={inputStyle}
                value={editing.startsAt}
                onChange={(e) => setEditing({ ...editing, startsAt: e.target.value })}
              />
            </s-stack>
            <s-stack direction="block" gap="small-300">
              <label htmlFor="sale-ends-at" style={{ fontWeight: 600 }}>
                End
              </label>
              <input
                id="sale-ends-at"
                type="datetime-local"
                style={inputStyle}
                value={editing.endsAt}
                onChange={(e) => setEditing({ ...editing, endsAt: e.target.value })}
              />
            </s-stack>
            <s-text color="subdued">Times are in the store time zone ({timezone}).</s-text>
            {(nameProblem || editProblem) && (
              <s-text tone="critical">{nameProblem || editProblem}</s-text>
            )}
          </s-stack>
        )}
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={!editing || !!editProblem || !!nameProblem || (busy && busyIntent !== "updateDates")}
          {...(busyIntent === "updateDates" ? { loading: true } : {})}
          onClick={() =>
            editing &&
            submit({
              intent: "updateDates",
              id: String(editing.id),
              name: editing.name,
              startsAt: editing.startsAt,
              endsAt: editing.endsAt,
            })
          }
        >
          Save
        </s-button>
        <s-button slot="secondary-actions" commandFor="edit-dates-modal" command="--hide">
          Cancel
        </s-button>
      </s-modal>

      <s-modal id="products-modal" heading={viewing ? viewing.name : "Products"}>
        {viewing && (
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              {viewing.products.length} products, in the order they appear in the collection.
            </s-text>
            <s-scroll-box maxBlockSize="360px">
              <s-ordered-list>
                {viewing.products.map((p) => (
                  <s-list-item key={p.id}>{p.title}</s-list-item>
                ))}
              </s-ordered-list>
            </s-scroll-box>
            {viewing.unmatched.length > 0 && (
              <s-stack direction="block" gap="small-200">
                <s-text tone="critical" type="strong">
                  Not found in the store ({viewing.unmatched.length})
                </s-text>
                <s-unordered-list>
                  {viewing.unmatched.map((n, i) => (
                    <s-list-item key={i}>{n}</s-list-item>
                  ))}
                </s-unordered-list>
              </s-stack>
            )}
          </s-stack>
        )}
        <s-button slot="secondary-actions" commandFor="products-modal" command="--hide">
          Close
        </s-button>
      </s-modal>

      <s-modal id="delete-modal" heading="Delete sale?">
        <s-paragraph>
          {deleting
            ? `"${deleting.name}" will be removed. If it is live, its products leave the collection on the next sync.`
            : ""}
        </s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          disabled={busy && busyIntent !== "deleteSale"}
          {...(busyIntent === "deleteSale" ? { loading: true } : {})}
          onClick={() => deleting && submit({ intent: "deleteSale", id: String(deleting.id) })}
        >
          Delete
        </s-button>
        <s-button slot="secondary-actions" commandFor="delete-modal" command="--hide">
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
