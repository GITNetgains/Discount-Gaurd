import styles from "../styles/discount-dashboard.module.css";

export interface DashboardData {
  eligibleCollectionId: string | null;
  protectionOn: boolean;
  syncPending: boolean;
  lastSyncAt: string | null;
  saleSyncAt: string | null;
  saleSyncFailed: boolean;
  timeZone: string;
  coverageError: string | null;
  coverage: { id: string; title: string; covered: boolean; shippingOnly: boolean }[];
  liveSales: { id: number; name: string; startsAt: string; endsAt: string; productCount: number }[];
  upcomingCount: number;
}

function dateLabel(value: string | null, timeZone: string) {
  if (!value) return "Not synced yet";
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" }).format(new Date(value));
  } catch { return new Date(value).toISOString().slice(0, 16).replace("T", " ") + " UTC"; }
}

export function DiscountDashboard({ data, isResyncing, onResync, syncResult, syncError }: {
  data: DashboardData;
  isResyncing: boolean;
  onResync: () => void;
  syncResult?: { eligible: number; excluded: number };
  syncError?: string;
}) {
  const protectedCount = data.coverage.filter(row => row.covered).length;
  const review = data.coverage.filter(row => !row.covered && !row.shippingOnly);
  const active = data.protectionOn && !data.syncPending;
  const status = !data.protectionOn ? "Protection off" : data.syncPending ? "Sync needed" : "Protection on";
  return (
    <s-page heading="Overview" inlineSize="large">
      <s-button slot="primary-action" variant="primary" href="/app/discounts/new" icon="plus">Create discount</s-button>
      {data.eligibleCollectionId && (
        <s-button slot="secondary-actions" icon="refresh" onClick={onResync} {...(isResyncing ? { loading: true } : {})}>Resync products</s-button>
      )}
      <div className={styles.dashboard}>
        <section className={styles.hero} aria-labelledby="dashboard-title">
          <div className={styles.heroCopy}>
            <span className={styles.eyebrow}>DISCOUNT GUARD</span>
            <h2 id="dashboard-title">Your promotions, in focus.</h2>
            <p>Keep product protection, discount coverage, and live sales in one place.</p>
          </div>
          <div className={styles.heroStatus}>
            <div className={active ? styles.statusOn : styles.statusOff}>
              <s-icon type="shield-check-mark" /><span>{status}</span>
            </div>
            <span>Compare-at price exclusions</span>
            <s-link href="/app/settings">Manage settings</s-link>
          </div>
        </section>

        {syncError && <s-banner tone="critical" heading="Resync could not finish">{syncError}</s-banner>}
        {syncResult && <s-banner tone="success" heading="Product eligibility updated">{syncResult.eligible} eligible products and {syncResult.excluded} excluded products. Review discount coverage below for any exceptions.</s-banner>}
        {data.coverageError ? (
          <s-banner tone="warning" heading="Discount coverage is unavailable">Coverage could not be verified. Open Settings to retry; protection status has not been inferred from missing data.</s-banner>
        ) : review.length > 0 && (
          <div className={styles.attention}>
            <span className={styles.attentionIcon}><s-icon type="alert-triangle" /></span>
            <div><strong>{review.length} {review.length === 1 ? "discount needs" : "discounts need"} attention</strong>
              <p>{review.slice(0, 2).map(row => row.title).join(", ")}{review.length > 2 ? ` and ${review.length - 2} more` : ""} {review.length === 1 ? "is" : "are"} outside the protected discount scopes.</p>
            </div>
            <s-button href="/app/settings">Review coverage</s-button>
          </div>
        )}
        {!data.protectionOn && <s-banner tone="warning" heading="Compare-at protection is turned off">Existing discounts use their original product selections. Turn protection on in Settings to exclude compare-at priced products.</s-banner>}
        {data.protectionOn && data.syncPending && <s-banner tone="warning" heading="Protection needs a resync">Save &amp; resync in Settings to finish applying your protection rule.</s-banner>}

        <div className={styles.metrics}>
          <Metric label="Protected discounts" value={data.coverageError ? "—" : String(protectedCount)} detail="Active discounts using protected scopes" icon="shield-check-mark" tone="green" />
          <Metric label="Needs review" value={data.coverageError ? "—" : String(review.length)} detail="Discounts requiring a separate exclusion" icon="alert-circle" tone="amber" />
          <Metric label="Live sales" value={String(data.liveSales.length)} detail="Currently within their sale dates" icon="calendar-check" tone="blue" />
          <Metric label="Upcoming sales" value={String(data.upcomingCount)} detail="Scheduled to start automatically" icon="clock" tone="purple" />
        </div>

        <div className={styles.columns}>
          <section className={styles.card} aria-labelledby="coverage-title">
            <div className={styles.cardHeader}>
              <div><h3 id="coverage-title">Discount coverage</h3><p>Know which active discounts follow your protection rule.</p></div>
              <s-link href="/app/settings">View settings</s-link>
            </div>
            {data.coverageError ? <div className={styles.empty}><s-icon type="alert-circle" /><p>Coverage could not be loaded.</p><s-button href="/app/settings">Check settings</s-button></div>
              : !data.coverage.length ? <div className={styles.empty}><s-icon type="discount-code" /><h4>No active discounts yet</h4><p>Create a code to start running protected promotions.</p><s-button href="/app/discounts/new" variant="primary">Create your first discount</s-button></div>
                : <>
                  <div className={styles.coverageSummary}>
                    <div><strong>{protectedCount} of {data.coverage.length}</strong><span> active discounts use protected scopes</span></div>
                    <div className={styles.progress} role="progressbar" aria-label="Protected active discounts" aria-valuemin={0} aria-valuemax={data.coverage.length} aria-valuenow={protectedCount}>
                      <span style={{ width: `${protectedCount / data.coverage.length * 100}%` }} />
                    </div>
                  </div>
                  <div className={styles.tableWrap}><table className={styles.table}>
                    <thead><tr><th scope="col">Discount</th><th scope="col">Protection</th></tr></thead>
                    <tbody>{data.coverage.map(row => <tr key={row.id}>
                      <td><span className={styles.discountIcon}><s-icon type="discount-code" /></span><s-link href={`shopify://admin/discounts/${row.id}`}>{row.title}</s-link></td>
                      <td><s-badge tone={row.covered ? "success" : row.shippingOnly ? "info" : "warning"}>{row.covered ? "Protected scope" : row.shippingOnly ? "Shipping only" : "Needs review"}</s-badge></td>
                    </tr>)}</tbody>
                  </table></div>
                </>}
          </section>

          <aside className={styles.sideStack}>
            <section className={styles.card} aria-labelledby="rules-title">
              <div className={styles.cardHeader}><div><h3 id="rules-title">Protection at a glance</h3><p>Your current product rules.</p></div></div>
              <div className={styles.ruleList}>
                <div><span>Compare-at products</span><s-badge tone={active ? "success" : "warning"}>{!data.protectionOn ? "Allowed" : data.syncPending ? "Sync pending" : "Excluded"}</s-badge></div>
                <div><span>Regular-price products</span><strong>Remain eligible</strong></div>
                <div><span>Mixed carts</span><strong>Supported</strong></div>
                <div><span>Background checks</span><strong>Every 5 minutes</strong></div>
              </div>
              <div className={styles.ruleNote}>MAP Restricted exclusions also apply to Discount Guard codes. Third-party discounts need their own exclusions.</div>
              <div className={styles.cardFooter}><s-button href="/app/settings" inlineSize="fill">Manage protection</s-button></div>
            </section>
            <section className={styles.syncCard}>
              <span className={styles.syncIcon}><s-icon type="refresh" /></span>
              <div><h3>Keep products in sync</h3><p>Product changes trigger updates automatically. Run a manual resync after a large catalog update.</p>
                <span className={styles.syncDate}>Last manual resync: {dateLabel(data.lastSyncAt, data.timeZone)}</span>
                {data.eligibleCollectionId && <s-button onClick={onResync} {...(isResyncing ? { loading: true } : {})}>Resync now</s-button>}
              </div>
            </section>
          </aside>
        </div>

        <section className={styles.card} aria-labelledby="sales-title">
          <div className={styles.cardHeader}>
            <div><h3 id="sales-title">Live sale calendar</h3><p>Recently started sales appear first.</p></div>
            <s-button href="/app/sale-calendar" icon="calendar">Open calendar</s-button>
          </div>
          {data.saleSyncFailed && <div className={styles.salesWarning}><s-banner tone="warning" heading="Sale sync needs attention">The latest collection sync could not finish. Open Sale Calendar to review it.</s-banner></div>}
          {!data.liveSales.length ? <div className={styles.empty}><s-icon type="calendar" /><h4>No sales are live right now</h4><p>{data.upcomingCount ? `${data.upcomingCount} upcoming sales will appear here when they start.` : "Upload a sale sheet and set your dates in Sale Calendar."}</p></div>
            : <div className={styles.saleList}>{data.liveSales.slice(0, 5).map((sale, index) => <div className={styles.saleRow} key={sale.id}>
              <span className={index === 0 ? styles.saleNumberNew : styles.saleNumber}>{String(index + 1).padStart(2, "0")}</span>
              <div className={styles.saleInfo}><strong>{sale.name}</strong><span>Started {dateLabel(sale.startsAt, data.timeZone)}</span></div>
              <div className={styles.saleProducts}><strong>{sale.productCount}</strong><span>scheduled products</span></div>
              <s-badge tone="success">{index === 0 ? "Newest live" : "Live"}</s-badge>
            </div>)}</div>}
          <div className={styles.salesFooter}><span>Last calendar sync: {dateLabel(data.saleSyncAt, data.timeZone)}</span><s-link href="/app/sale-calendar">Manage all sales</s-link></div>
        </section>

        <div className={styles.quickActions}>
          <a href="/app/discounts/new" className={styles.quickAction}><s-icon type="discount-code" /><div><strong>Create a discount</strong><span>Launch a protected promotional code.</span></div><s-icon type="arrow-right" /></a>
          <a href="/app/bulk-tag" className={styles.quickAction}><s-icon type="catalog-product" /><div><strong>Organize product rules</strong><span>Manage MAP tags across your catalog.</span></div><s-icon type="arrow-right" /></a>
          <a href="/app/settings" className={styles.quickAction}><s-icon type="settings" /><div><strong>Protection settings</strong><span>Adjust rules and review discount coverage.</span></div><s-icon type="arrow-right" /></a>
        </div>
      </div>
    </s-page>
  );
}

function Metric({ label, value, detail, icon, tone }: { label: string; value: string; detail: string; icon: "shield-check-mark" | "alert-circle" | "calendar-check" | "clock"; tone: string }) {
  return <section className={styles.metric} aria-label={label}>
    <div className={styles.metricTop}><span>{label}</span><span className={`${styles.metricIcon} ${styles[tone]}`}><s-icon type={icon} /></span></div>
    <strong className={styles.metricValue}>{value}</strong><p>{detail}</p>
  </section>;
}
