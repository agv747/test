/** Presentation formatting helpers (no business logic). */

export function money(value, currency = 'SGD') {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${currency} ${value.toFixed(2)}`;
}

export function signedMoney(value, currency = 'SGD') {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${currency} ${Math.abs(value).toFixed(2)}`;
}

export function num(value, decimals = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(decimals);
}

export function pct(value, decimals = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(decimals)}%`;
}

export function signedPct(value, decimals = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(decimals)} pp`;
}

export function priceIndex(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(1);
}

export function dateLabel(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-SG', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function dateTimeLabel(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-SG', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function relativeDays(days) {
  if (days === null || days === undefined) return '—';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/** Escapes text for safe interpolation into template-literal HTML. */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
