(() => {
  const script = document.querySelector('script[data-discount-guard-groups]');
  if (!script || window.discountGuardSaleGroupsLoaded) return;
  window.discountGuardSaleGroupsLoaded = true;
  const endpoint = new URL('/storefront/sale-groups', script.src);
  endpoint.searchParams.set('shop', script.dataset.shop);
  endpoint.searchParams.set('collection', script.dataset.collection);
  const gridSelector = '[data-infinite-scroll-results], #product-grid, .product-list--rows';
  const main = document.querySelector('main') || document.body;
  let groups = [];
  let soldOut = new Set();
  let timezone;
  let observer;
  let scheduled = false;
  const originals = new WeakMap();
  const nativeDisplay = new WeakMap();
  const cacheKey = `discount-guard:v3:${endpoint.href}`;
  function readCache() {
    try {
      const entry = JSON.parse(sessionStorage.getItem(cacheKey));
      return entry?.expires > Date.now() ? entry.value : undefined;
    } catch { return undefined; }
  }
  function writeCache(value) {
    try { sessionStorage.setItem(cacheKey, JSON.stringify({ expires: Date.now() + 60_000, value })); } catch { /* Storage may be disabled. */ }
  }
  function scheduleApply() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(apply, 16);
  }
  const active = () => groups.length > 0 || soldOut.size > 0;
  const style = document.createElement('style');
  // Cards are reordered and some are hidden, so theme layouts that place cards by
  // position (floats, masonry offsets, reveal animations) would leave blank slots.
  style.textContent = `
    [data-dg-sale-active]{height:auto!important}
    [data-dg-sale-active][data-dg-sale-flow]{display:flex!important;flex-wrap:wrap;align-items:flex-start}
    [data-dg-sale-active] > :not([data-dg-sale-hidden]){clear:none!important;float:none!important;position:relative!important;top:auto!important;left:auto!important;right:auto!important;transform:none!important;opacity:1!important;visibility:visible!important}
    [data-dg-sale-active] > [data-dg-sale-hidden]{display:none!important}
    [data-dg-sale-heading]{flex-shrink:0}
  `;

  function loadImages(card) {
    for (const image of card.querySelectorAll('img')) {
      // Moving cards can leave them outside the theme's lazy-loading observer.
      const srcset = image.dataset.srcset;
      const src = image.dataset.src;
      const current = image.getAttribute('src') || '';
      // Leave real images and the theme's responsive image handling alone.
      if (current && !current.startsWith('data:') && !/placeholder|transparent|blank\./i.test(current)) continue;
      if (!src && !srcset) continue;
      if (image.dataset.dgImageLoaded === 'true') continue;
      image.dataset.dgImageLoaded = 'true';
      if (image.dataset.sizes && image.dataset.sizes !== 'auto') image.sizes = image.dataset.sizes;
      else if (image.dataset.sizes === 'auto') image.sizes = `${Math.ceil(card.getBoundingClientRect().width) || 400}px`;
      if (srcset && !srcset.includes('{width}')) image.srcset = srcset;
      if (src) image.src = src.replace(/\{width\}/g, String(Math.ceil(card.getBoundingClientRect().width * (window.devicePixelRatio || 1)) || 800));
      image.loading = 'lazy';
    }
  }

  function formatDate(date, withYear) {
    const options = { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) };
    try {
      return new Intl.DateTimeFormat('en-US', { ...options, timeZone: timezone }).format(date);
    } catch {
      return new Intl.DateTimeFormat('en-US', options).format(date);
    }
  }

  function yearOf(date) {
    try {
      return new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: timezone }).format(date);
    } catch {
      return String(date.getFullYear());
    }
  }

  /** "Nov 13 – Nov 20, 2026" in the store's time zone. */
  function saleDates(group) {
    const start = new Date(group.startsAt);
    let end = new Date(group.endsAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
    // A sale ending exactly at midnight runs through the previous day.
    try {
      const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZone: timezone }).formatToParts(end);
      const part = (type) => Number(parts.find((p) => p.type === type)?.value);
      if (part('hour') % 24 === 0 && part('minute') === 0 && end - start > 60_000) end = new Date(end.getTime() - 60_000);
    } catch { /* Keep the exact end date. */ }
    const sameYear = yearOf(start) === yearOf(end);
    const from = formatDate(start, !sameYear);
    const to = formatDate(end, true);
    return from === formatDate(end, !sameYear) ? to : `${from} – ${to}`;
  }

  function handleOf(card) {
    const link = card.querySelector('a[href*="/products/"]');
    if (!link) return null;
    return decodeURIComponent(new URL(link.href, location.href).pathname.split('/products/')[1]?.split('/')[0] || '');
  }

  function apply() {
    scheduled = false;
    observer?.disconnect();
    for (const grid of main.querySelectorAll(gridSelector)) {
      const cards = Array.from(grid.children).filter((card) => handleOf(card));
      if (!cards.length) continue;
      const previous = originals.get(grid) || [];
      const original = previous.filter((card) => cards.includes(card));
      for (const card of cards) if (!original.includes(card)) original.push(card);
      originals.set(grid, original);
      if (active()) {
        if (!style.isConnected) document.head.append(style);
        if (!nativeDisplay.has(grid)) nativeDisplay.set(grid, getComputedStyle(grid).display);
        // CSS grids already flow without gaps; everything else becomes a wrapping row.
        grid.toggleAttribute('data-dg-sale-flow', !/grid/.test(nativeDisplay.get(grid)));
        grid.dataset.dgSaleActive = '';
      } else {
        delete grid.dataset.dgSaleActive;
        delete grid.dataset.dgSaleFlow;
      }
      const existingHeadings = Array.from(grid.querySelectorAll(':scope > [data-dg-sale-heading]'));
      const visible = original.filter((card) => {
        const show = !soldOut.has(handleOf(card));
        card.toggleAttribute('data-dg-sale-hidden', !show);
        if (show && active()) loadImages(card);
        return show;
      });
      const remaining = new Set(visible);
      const desired = [];
      const usedHeadings = new Set();
      for (const group of groups) {
        const matched = group.handles.flatMap((handle) => visible.filter((card) => remaining.has(card) && handleOf(card) === handle));
        if (!matched.length) continue;
        const wrapper = existingHeadings.find((node) => !usedHeadings.has(node) && node.dataset.dgSaleHeading === group.name)
          || document.createElement(grid.matches('ul, ol') ? 'li' : 'div');
        usedHeadings.add(wrapper);
        wrapper.dataset.dgSaleHeading = group.name;
        wrapper.style.cssText = 'width:100%;flex-basis:100%;grid-column:1 / -1;clear:both;display:flow-root;list-style:none;text-align:left;box-sizing:border-box;margin:0 0 1.5rem;';
        const cardPadding = parseFloat(getComputedStyle(cards[0]).paddingLeft) || 0;
        const gridGutter = Math.max(0, -(parseFloat(getComputedStyle(grid).marginLeft) || 0));
        wrapper.style.paddingLeft = `${Math.max(cardPadding, gridGutter)}px`;
        let divider = wrapper.querySelector('[data-dg-sale-divider]');
        if (desired.length) {
          if (!divider) {
            divider = document.createElement('div');
            divider.dataset.dgSaleDivider = '';
            divider.setAttribute('aria-hidden', 'true');
            wrapper.prepend(divider);
          }
          divider.style.cssText = 'border-top:1px solid rgba(0,0,0,0.28);margin:1.75rem 0;';
        } else divider?.remove();
        const heading = wrapper.querySelector('h2') || document.createElement('h2');
        if (heading.textContent !== group.name) heading.textContent = group.name;
        heading.style.cssText = 'margin:0;text-align:left;';
        if (!heading.parentNode) wrapper.append(heading);
        const datesText = saleDates(group);
        let dates = wrapper.querySelector('[data-dg-sale-dates]');
        if (datesText) {
          if (!dates) {
            dates = document.createElement('p');
            dates.dataset.dgSaleDates = '';
          }
          if (dates.textContent !== datesText) dates.textContent = datesText;
          dates.style.cssText = 'margin:0.35rem 0 0;text-align:left;font-size:0.95em;opacity:0.75;letter-spacing:0.01em;';
          if (dates.previousElementSibling !== heading) heading.after(dates);
        } else dates?.remove();
        desired.push(wrapper);
        for (const card of matched) {
          remaining.delete(card);
          desired.push(card);
        }
      }
      for (const card of remaining) desired.push(card);
      // Hidden cards go last so they can never sit between visible ones.
      for (const card of original) if (!visible.includes(card)) desired.push(card);
      for (const heading of existingHeadings) if (!usedHeadings.has(heading)) heading.remove();
      let cursor = grid.firstElementChild;
      for (const node of desired) {
        if (node === cursor) cursor = cursor.nextElementSibling;
        else grid.insertBefore(node, cursor);
      }
    }
    observer?.observe(main, { childList: true, subtree: true });
  }

  function use(data) {
    groups = Array.isArray(data?.groups) ? data.groups : [];
    soldOut = new Set(Array.isArray(data?.soldOut) ? data.soldOut : []);
    timezone = typeof data?.timezone === 'string' ? data.timezone : undefined;
  }

  async function refresh() {
    try {
      const response = await fetch(endpoint, { credentials: 'omit', cache: 'no-store' });
      if (!response.ok) return;
      const result = await response.json();
      if (!Array.isArray(result.groups)) return;
      use(result);
      writeCache({ groups, soldOut: [...soldOut], timezone });
      if (!active() && !observer) return;
      if (!observer) {
        observer = new MutationObserver((records) => {
          const gridChanged = records.some((record) => {
            if (record.target instanceof Element && record.target.matches(gridSelector)) return true;
            return [...record.addedNodes, ...record.removedNodes].some((node) =>
              node instanceof Element && (node.matches(gridSelector) || node.querySelector(gridSelector)));
          });
          if (gridChanged) scheduleApply();
        });
      }
      apply();
    } catch {
      // Leave the theme's collection intact if the app is unavailable.
    }
  }
  const cachedData = readCache();
  if (cachedData) {
    use(cachedData);
    if (active()) apply();
  }
  refresh();
  window.addEventListener('resize', () => { if (observer) scheduleApply(); });
  setInterval(refresh, 60_000);
})();
