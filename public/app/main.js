/**
 * Application shell and router.
 *
 * Hash routing keeps the app deployable as static assets behind a Cloudflare Worker.
 * Pages are pure render functions returning HTML; behaviour is wired through delegated
 * events, so no framework is required.
 */

import * as store from './store.js';
import { registerProvider, setActiveProvider } from './services/recognition/provider.js';
import { mockRecognitionProvider } from './services/recognition/mockProvider.js';
import { registerRemoteProviders } from './services/recognition/remoteProvider.js';
import { RECOGNITION_MODELS, DEFAULT_RECOGNITION_MODEL } from './config.js';
import { buildAnalytics } from './services/analyticsService.js';
import { esc } from './lib/format.js';

import * as fieldHome from './ui/fieldHome.js';
import * as priceCheck from './ui/priceCheck.js';
import * as myVisits from './ui/myVisits.js';
import * as outletsPage from './ui/outlets.js';
import * as outletDetail from './ui/outletDetail.js';
import * as gmOverview from './ui/gmOverview.js';
import * as controlTower from './ui/controlTower.js';
import * as opportunities from './ui/opportunities.js';
import * as skuIntelligence from './ui/skuIntelligence.js';
import * as priceArchitecture from './ui/priceArchitecture.js';
import * as competitorMoves from './ui/competitorMoves.js';
import * as fieldEffectiveness from './ui/fieldEffectiveness.js';
import * as territories from './ui/territories.js';
import * as priceRules from './ui/priceRules.js';
import * as competitorMapping from './ui/competitorMapping.js';
import * as imageReview from './ui/imageReview.js';
import * as admin from './ui/admin.js';
import * as executionPage from './execution/ui.js';
import { initExecution, getExecution } from './execution/client.js';
import { configuredSingaporeProvider } from './execution/sg-provider.js';
import { MODULES, selectedModule, moduleForPath, moduleHome } from './module-navigation.js';

// Every configured model becomes a provider; the simulator stays the default so a fresh
// install never spends money without someone choosing to.
registerProvider(mockRecognitionProvider);
registerRemoteProviders(RECOGNITION_MODELS);
registerProvider(configuredSingaporeProvider);
setActiveProvider(DEFAULT_RECOGNITION_MODEL);

const ROUTES = {
  'field/home': fieldHome,
  'field/check': priceCheck,
  'field/visits': myVisits,
  'field/outlets': outletsPage,
  'outlet': outletDetail,
  'manager/overview': gmOverview,
  'manager/tower': controlTower,
  'manager/opportunities': opportunities,
  'manager/sku': skuIntelligence,
  'manager/architecture': priceArchitecture,
  'manager/competitor-moves': competitorMoves,
  'manager/field-effectiveness': fieldEffectiveness,
  'manager/territories': territories,
  'manager/outlets': outletsPage,
  'admin/price-rules': priceRules,
  'admin/competitor-mapping': competitorMapping,
  'admin/image-review': imageReview,
  'admin/master-data': admin,
  'tw/overview': executionPage,
  'tw/audits/new': executionPage,
  'tw/audits/detail': executionPage,
  'tw/planograms': executionPage,
  'tw/planograms/detail': executionPage,
  'tw/issues': executionPage,
  'admin/ai': executionPage,
};

const FIELD_NAV = [
  { route: 'field/home', label: 'Home', icon: '⌂' },
  { route: 'field/check', label: 'Start Price Check', icon: '◉' },
  { route: 'field/visits', label: 'My Visits', icon: '≡' },
  { route: 'field/outlets', label: 'Outlets', icon: '⌖' },
];

const MANAGER_NAV = [
  { section: 'Intelligence' },
  { route: 'manager/overview', label: 'GM Overview', icon: '★' },
  { route: 'manager/tower', label: 'Price Control Tower', icon: '◎' },
  { route: 'manager/opportunities', label: 'Pricing Opportunities', icon: '◈' },
  { route: 'manager/sku', label: 'SKU Intelligence', icon: '▤' },
  { route: 'manager/architecture', label: 'Price Architecture', icon: '≣' },
  { route: 'manager/competitor-moves', label: 'Competitor Moves', icon: '⇄' },
  { route: 'manager/field-effectiveness', label: 'Field Effectiveness', icon: '↗' },
  { section: 'Network' },
  { route: 'manager/territories', label: 'Territories', icon: '⬢' },
  { route: 'manager/outlets', label: 'Outlets', icon: '⌖' },
  { section: 'Administration' },
  { route: 'admin/price-rules', label: 'Price Rules', icon: '⚖' },
  { route: 'admin/competitor-mapping', label: 'Competitor Mapping', icon: '⇌' },
  { route: 'admin/image-review', label: 'Image Review', icon: '⌗' },
  { route: 'admin/master-data', label: 'Admin / Master Data', icon: '⚙' },
  { route: 'admin/ai', label: 'AI Models & Connections', icon: '✦' },
];

const TAIWAN_NAV = [
  { section: 'Retail execution' },
  { route: 'tw/overview', label: 'Execution Overview', icon: '◎' },
  { route: 'tw/audits/new', label: 'Start Cabinet Audit', icon: '▣' },
  { route: 'tw/issues', label: 'Execution Issues', icon: '⇄' },
  { section: 'Reference & AI' },
  { route: 'tw/planograms', label: 'Planogram Library', icon: '▦' },
  { route: 'admin/ai', label: 'AI Models & Connections', icon: '✦' },
];
const isTaiwan = ctx => moduleForPath(ctx.path, store.getSession()) === 'planogram';
const navigation = ctx => isTaiwan(ctx) ? TAIWAN_NAV : ctx.user.role === 'field' ? FIELD_NAV : MANAGER_NAV;

/* --------------------------------------------------------------- routing */

export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  return { path: path || defaultRoute(), params };
}

/**
 * Where a manager lands.
 *
 * The GM Overview, not the Control Tower. The Tower opens with a nine-field filter form, eight
 * KPI cards and a paragraph of disclaimer before the first conclusion, which is the right
 * arrangement for someone who lives in the screen and the wrong one for someone arriving at it.
 * The Tower is one click away and keeps everything.
 */
function defaultRoute() {
  return moduleHome(selectedModule(store.getSession()), store.currentUser()?.role);
}

export function navigate(path, params = {}) {
  if (path.startsWith('tw/')) store.setSession({ module: 'planogram' });
  else if (path !== 'admin/ai') store.setSession({ module: 'price' });
  const query = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ).toString();
  location.hash = `#/${path}${query ? `?${query}` : ''}`;
}

/** Updates query params on the current route without losing page state. */
export function setParams(patch) {
  const { path, params } = parseHash();
  navigate(path, { ...params, ...patch });
}

/* --------------------------------------------------------------- filters */

/** Only these `data-filter` names mutate the shared manager filter state. */
const GLOBAL_FILTER_KEYS = new Set([
  'from',
  'to',
  'territory_id',
  'channel_id',
  'user_id',
  'outlet_id',
  'brand_id',
  'sku_id',
  'ownership',
  'min_confidence',
  'strategic_only',
]);

export function getFilters() {
  return store.getSession().filters ?? {};
}

export function setFilters(patch) {
  const filters = { ...getFilters(), ...patch };
  for (const key of Object.keys(filters)) {
    if (filters[key] === '' || filters[key] === null || filters[key] === undefined) delete filters[key];
  }
  store.setSession({ filters });
}

/* ---------------------------------------------------------------- render */

let currentPage = null;

function buildContext() {
  const { path, params } = parseHash();
  const data = store.getData();
  const config = store.getConfig();
  const user = store.currentUser();
  const filters = getFilters();
  return {
    path,
    params,
    data,
    config,
    user,
    filters,
    store,
    navigate,
    setParams,
    setFilters,
    render,
    /** Lazily computed so field pages never pay for manager analytics. */
    get analytics() {
      if (!this._analytics) this._analytics = buildAnalytics(data, filters, config);
      return this._analytics;
    },
  };
}

function navHtml(ctx) {
  const items = navigation(ctx);
  return items
    .map((item) => {
      if (item.section) return `<div class="sidebar__section">${esc(item.section)}</div>`;
      const active = ctx.path === item.route || (item.route === 'manager/outlets' && ctx.path === 'outlet');
      return `<button class="navlink${active ? ' navlink--active' : ''}" data-nav="${esc(item.route)}">
        <span class="navlink__icon">${item.icon}</span>${esc(item.label)}</button>`;
    })
    .join('');
}

/** Open state of the phone "More" sheet. Closed on every navigation. */
let moreOpen = false;

/**
 * The bottom bar on a phone.
 *
 * A manager has twelve destinations and the bar holds four, so the rest reach the phone
 * through "More" rather than being cut off: before this, Field Effectiveness, Territories,
 * Outlets, Price Rules, Competitor Mapping, Image Review and Admin simply did not exist for
 * anyone on a phone, because the bar was the whole of their navigation.
 */
function mobileNavHtml(ctx) {
  const isField = ctx.user.role === 'field' && !isTaiwan(ctx);
  const destinations = navigation(ctx).filter((i) => !i.section);
  const shown = isField ? destinations : destinations.slice(0, 4);
  const hidden = destinations.length - shown.length;

  const button = (item) =>
    `<button data-nav="${esc(item.route)}" class="${ctx.path === item.route ? 'is-active' : ''}">
      <span class="icon">${item.icon}</span>${esc(item.label)}</button>`;

  const rest = hidden
    ? `<button data-action="toggle-more-nav" aria-expanded="${moreOpen}"
        class="${!shown.some((i) => i.route === ctx.path) ? 'is-active' : ''}">
        <span class="icon">${moreOpen ? '✕' : '⋯'}</span>${moreOpen ? 'Close' : 'More'}</button>`
    : '';

  return shown.map(button).join('') + rest;
}

/** Every destination, as a sheet over the page, so nothing is unreachable on a phone. */
function moreNavSheet(ctx) {
  if (!moreOpen || (ctx.user.role === 'field' && !isTaiwan(ctx))) return '';
  const items = navigation(ctx).map((item) => {
    if (item.section) return `<div class="more-nav__section">${esc(item.section)}</div>`;
    const active = ctx.path === item.route || (item.route === 'manager/outlets' && ctx.path === 'outlet');
    return `<button class="more-nav__link${active ? ' is-active' : ''}" data-nav="${esc(item.route)}">
      <span class="more-nav__icon">${item.icon}</span>${esc(item.label)}</button>`;
  }).join('');

  return `<div class="more-nav" role="dialog" aria-label="All sections">
    <div class="more-nav__sheet">
      <div class="more-nav__head">
        <strong>All sections</strong>
        <button class="btn btn--sm" data-action="toggle-more-nav">✕ Close</button>
      </div>
      ${items}
    </div>
  </div>`;
}

/**
 * Says where the data on screen came from. Without this, an app falling back to the bundled
 * seed looks identical to one reading shared observations — and a TME could submit a visit
 * that never leaves their browser.
 */
function sourceIndicator() {
  const { source, error } = store.dataSource();
  if (error) {
    return `<span class="pill pill--risk" title="${esc(error)}">▲ Not saving</span>`;
  }
  return source === 'database'
    ? '<span class="pill pill--good" title="Observations are read from and written to the shared database">✓ Shared database</span>'
    : '<span class="pill pill--watch" title="No database reachable — this browser only, changes are not shared">! Local demo data</span>';
}

/**
 * Marks the dataset as synthetic, and puts the presentation controls where they belong.
 *
 * "Reset demo" used to sit in the top bar of every business screen, one click from the numbers
 * a manager is reading — a destructive control at the same size and prominence as the work. It
 * lives in Admin now, beside its warning, and this badge says what the data is and points at it.
 * The persona switcher stays: the demo script moves between a TME and a manager, and hiding
 * that would make the story harder to follow rather than safer.
 */
function demoBadge() {
  return `<button class="pill pill--info" data-nav="admin/master-data"
    title="Synthetic demonstration dataset. Reset and other presentation controls are in Admin."
    style="cursor:pointer;border-style:solid">Demo data</button>`;
}

function roleSwitcher(ctx) {
  return `<select data-action="switch-user" aria-label="Switch user" style="width:auto">
    ${ctx.data.users
      .filter((u) => u.active !== false)
      .map(
        (u) =>
          `<option value="${esc(u.id)}"${u.id === ctx.user.id ? ' selected' : ''}>${esc(u.name)} — ${esc(
            u.role === 'field' ? 'Trade Marketer' : u.role === 'manager' ? 'Manager' : 'Admin',
          )}</option>`,
      )
      .join('')}
  </select>`;
}

let lastRenderedHash = null;
export function render() {
  const ctx = buildContext();
  const activeModule = moduleForPath(ctx.path, store.getSession());
  if (store.getSession().module !== activeModule) store.setSession({ module: activeModule });
  const page = ROUTES[ctx.path] ?? ROUTES[defaultRoute()];
  currentPage = page;

  const root = document.getElementById('root');
  const scrollBefore = window.scrollY;
  let body;
  try {
    body = page.render(ctx);
  } catch (err) {
    console.error('Page render failed', err);
    body = `<div class="card"><h2>Something went wrong on this page</h2>
      <p class="small muted">${esc(err.message)}</p>
      <button class="btn" data-action="reset-demo">Reset demo data</button></div>`;
  }

  root.innerHTML = `
    <div class="app">
      <nav class="sidebar">
        <div class="sidebar__brand">
          <strong>Retail Execution Intelligence</strong>
          <span>${MODULES[moduleForPath(ctx.path, store.getSession())].label}</span>
        </div>
        ${navHtml(ctx)}
        <div class="sidebar__footer">
          ${isTaiwan(ctx) ? 'Approved reference. Visible evidence. A verified action loop.' : 'Outlets set their own retail price. This tool observes and prioritises — it does not enforce.'}
        </div>
      </nav>
      <div class="main">
        <header class="topbar">
          <div class="topbar__title">
            <h1>${esc(page.title(ctx))}</h1>
            <small>${page.subtitle ? esc(page.subtitle(ctx)) : ''}</small>
          </div>
          <select data-action="switch-module" aria-label="Module" style="width:auto"><option value="price"${isTaiwan(ctx) ? '' : ' selected'}>Price Validation</option><option value="planogram"${isTaiwan(ctx) ? ' selected' : ''}>Planogram Check</option></select>
          <span class="small muted" title="Existing dataset scope; switching modules does not change its market or currency">Data scope: ${isTaiwan(ctx) ? 'TW · UTC+08' : 'SG · SGD'}</span>
          ${isTaiwan(ctx) || ctx.path === 'admin/ai' ? `<span class="pill pill--info">${getExecution().mode === 'shared' ? esc(getExecution().actor?.name ?? 'Private workspace') : 'Demo workspace'}</span>` : `${sourceIndicator()}${demoBadge()}${roleSwitcher(ctx)}`}
        </header>
        <main class="content${page.narrow ? ' content--narrow' : ''}">${body}</main>
        <nav class="mobile-nav">${mobileNavHtml(ctx)}</nav>
        ${moreNavSheet(ctx)}
      </div>
    </div>`;

  if (page.mount) page.mount(ctx, root);
  // Going somewhere new starts at the top; redrawing the page you are already on must not move
  // you. Polling a recognition run re-renders this view every couple of seconds, and scrolling to
  // zero each time made the page jump under the reader while they were still looking at it.
  const navigated = lastRenderedHash !== location.hash;
  lastRenderedHash = location.hash;
  if (navigated) { window.scrollTo(0, 0); return; }
  // Restoring needs the new layout to exist. Straight after `innerHTML` the document still has
  // the collapsed height of an empty root, so a restore is silently clamped to a few pixels —
  // which looks exactly like the jump this is meant to stop. Force layout, then restore, and
  // keep a frame-later attempt for content that settles its height asynchronously.
  void document.body.offsetHeight;
  window.scrollTo(0, scrollBefore);
  if (window.scrollY !== scrollBefore) requestAnimationFrame(() => window.scrollTo(0, scrollBefore));
}

/* -------------------------------------------------------------- events */

function delegate(root) {
  root.addEventListener('click', (event) => {
    const nav = event.target.closest('[data-nav]');
    if (nav) {
      moreOpen = false;
      navigate(nav.dataset.nav);
      return;
    }
    const action = event.target.closest('[data-action]');
    if (!action) return;

    if (action.dataset.action === 'toggle-more-nav') {
      moreOpen = !moreOpen;
      render();
      return;
    }

    if (action.dataset.action === 'reset-demo') {
      const { source } = store.dataSource();
      // Neither branch touches another person's work: against a database this re-reads it,
      // and locally it rewrites this browser's own copy only.
      const message =
        source === 'database'
          ? 'Discard this browser\u2019s local settings and reload the shared dataset from the database? Nothing stored in the database is changed.'
          : 'Reset this browser\u2019s demo data back to the seeded dataset? No other user is affected.';
      if (confirm(message)) {
        store.reload().then(render);
      }
      return;
    }
    if (currentPage?.onAction) currentPage.onAction(action.dataset.action, action, buildContext());
  });

  root.addEventListener('change', (event) => {
    const target = event.target;
    if (target.dataset.action === 'switch-module') {
      if (!Object.hasOwn(MODULES, target.value)) return;
      store.setSession({ module: target.value });
      navigate(moduleHome(target.value, store.currentUser()?.role));
      render();
      return;
    }
    if (target.dataset.action === 'switch-user') {
      const user = store.getData().users.find((u) => u.id === target.value);
      store.setSession({ user_id: user.id, role: user.role });
      navigate(user.role === 'field' ? 'field/home' : 'manager/overview');
      render();
      return;
    }
    const ctx = buildContext();
    // Pages get first refusal — some filters (checkboxes, numeric coercion) need custom
    // handling, and page-local selects reuse the same `data-filter` attribute.
    const handled = currentPage?.onChange ? currentPage.onChange(target, ctx) : false;
    if (handled === true) return;

    if (target.dataset.filter && GLOBAL_FILTER_KEYS.has(target.dataset.filter)) {
      setFilters({ [target.dataset.filter]: target.value });
      render();
    }
  });

  root.addEventListener('input', (event) => {
    if (currentPage?.onInput) currentPage.onInput(event.target, buildContext());
  });

  root.addEventListener('submit', (event) => {
    if (currentPage?.onSubmit) {
      event.preventDefault();
      currentPage.onSubmit(event.target, buildContext());
    }
  });
}

export async function start() {
  const root = document.getElementById('root');
  root.innerHTML = '<div style="padding:40px;text-align:center;color:#5b6472">Loading price data…</div>';

  // The dataset is loaded once, before the first render, so every page and service can keep
  // reading it synchronously.
  await store.init();
  await initExecution();

  // The chosen model lives in configuration, so it survives a reload.
  const chosen = getExecution().actor && getExecution().ai?.routes.some(r => r.task === 'sg_price_recognition')
    ? 'configured-sg' : store.getConfig().recognition_model ?? DEFAULT_RECOGNITION_MODEL;
  try {
    setActiveProvider(chosen);
  } catch {
    setActiveProvider(DEFAULT_RECOGNITION_MODEL);
  }

  delegate(root);
  window.addEventListener('hashchange', render);
  if (!location.hash) navigate(defaultRoute());
  render();
}
