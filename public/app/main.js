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
import { buildAnalytics } from './services/analyticsService.js';
import { esc } from './lib/format.js';

import * as fieldHome from './ui/fieldHome.js';
import * as priceCheck from './ui/priceCheck.js';
import * as myVisits from './ui/myVisits.js';
import * as outletsPage from './ui/outlets.js';
import * as outletDetail from './ui/outletDetail.js';
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

registerProvider(mockRecognitionProvider);
setActiveProvider(mockRecognitionProvider.id);

const ROUTES = {
  'field/home': fieldHome,
  'field/check': priceCheck,
  'field/visits': myVisits,
  'field/outlets': outletsPage,
  'outlet': outletDetail,
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
};

const FIELD_NAV = [
  { route: 'field/home', label: 'Home', icon: '⌂' },
  { route: 'field/check', label: 'Start Price Check', icon: '◉' },
  { route: 'field/visits', label: 'My Visits', icon: '≡' },
  { route: 'field/outlets', label: 'Outlets', icon: '⌖' },
];

const MANAGER_NAV = [
  { section: 'Intelligence' },
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
];

/* --------------------------------------------------------------- routing */

export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  return { path: path || defaultRoute(), params };
}

function defaultRoute() {
  return store.currentUser()?.role === 'field' ? 'field/home' : 'manager/tower';
}

export function navigate(path, params = {}) {
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
  const items = ctx.user.role === 'field' ? FIELD_NAV : MANAGER_NAV;
  return items
    .map((item) => {
      if (item.section) return `<div class="sidebar__section">${esc(item.section)}</div>`;
      const active = ctx.path === item.route || (item.route === 'manager/outlets' && ctx.path === 'outlet');
      return `<button class="navlink${active ? ' navlink--active' : ''}" data-nav="${esc(item.route)}">
        <span class="navlink__icon">${item.icon}</span>${esc(item.label)}</button>`;
    })
    .join('');
}

function mobileNavHtml(ctx) {
  const items = (ctx.user.role === 'field' ? FIELD_NAV : MANAGER_NAV.filter((i) => !i.section)).slice(0, 5);
  return items
    .map(
      (item) =>
        `<button data-nav="${esc(item.route)}" class="${ctx.path === item.route ? 'is-active' : ''}">
          <span class="icon">${item.icon}</span>${esc(item.label)}</button>`,
    )
    .join('');
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

export function render() {
  const ctx = buildContext();
  const page = ROUTES[ctx.path] ?? ROUTES[defaultRoute()];
  currentPage = page;

  const root = document.getElementById('root');
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
          <strong>Retail Price Intelligence</strong>
          <span>Singapore · SGD</span>
        </div>
        ${navHtml(ctx)}
        <div class="sidebar__footer">
          Outlets set their own retail price. This tool observes and prioritises — it does not enforce.
        </div>
      </nav>
      <div class="main">
        <header class="topbar">
          <div class="topbar__title">
            <h1>${esc(page.title(ctx))}</h1>
            <small>${page.subtitle ? esc(page.subtitle(ctx)) : ''}</small>
          </div>
          ${sourceIndicator()}
          ${roleSwitcher(ctx)}
          <button class="btn btn--sm" data-action="reset-demo" title="Restore the demo dataset">Reset demo</button>
        </header>
        <main class="content${page.narrow ? ' content--narrow' : ''}">${body}</main>
        <nav class="mobile-nav">${mobileNavHtml(ctx)}</nav>
      </div>
    </div>`;

  if (page.mount) page.mount(ctx, root);
  window.scrollTo(0, 0);
}

/* -------------------------------------------------------------- events */

function delegate(root) {
  root.addEventListener('click', (event) => {
    const nav = event.target.closest('[data-nav]');
    if (nav) {
      navigate(nav.dataset.nav);
      return;
    }
    const action = event.target.closest('[data-action]');
    if (!action) return;

    if (action.dataset.action === 'reset-demo') {
      const { source } = store.dataSource();
      const message =
        source === 'database'
          ? 'Discard local settings and reload the shared dataset from the database?'
          : 'Reset all demo data back to the seeded dataset?';
      if (confirm(message)) {
        store.reload().then(render);
      }
      return;
    }
    if (currentPage?.onAction) currentPage.onAction(action.dataset.action, action, buildContext());
  });

  root.addEventListener('change', (event) => {
    const target = event.target;
    if (target.dataset.action === 'switch-user') {
      const user = store.getData().users.find((u) => u.id === target.value);
      store.setSession({ user_id: user.id, role: user.role });
      navigate(user.role === 'field' ? 'field/home' : 'manager/tower');
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

  delegate(root);
  window.addEventListener('hashchange', render);
  if (!location.hash) navigate(defaultRoute());
  render();
}
