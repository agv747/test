export const MODULES = {
  price: { label: 'Price Validation', description: 'Capture, review and validate price data' },
  planogram: { label: 'Planogram Check', description: 'Compare visible evidence with a reference layout' },
};

// Keep legacy links and stored sessions working without using market as module state.
export function selectedModule(session = {}) {
  if (Object.hasOwn(MODULES, session.module)) return session.module;
  return session.market === 'TW' ? 'planogram' : 'price';
}
export function moduleForPath(path, session = {}) {
  if (path.startsWith('tw/')) return 'planogram';
  if (path === 'admin/ai') return selectedModule(session);
  return 'price';
}
export function moduleHome(module, role) {
  return module === 'planogram' ? 'tw/overview' : role === 'field' ? 'field/home' : 'manager/overview';
}
