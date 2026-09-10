/** RFC4180-ish CSV serialisation / parsing used by exports (§32) and master-data import (§20). */

function escapeCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * @param {string[]} columns column keys, used as header row
 * @param {object[]} rows
 */
export function toCsv(columns, rows) {
  const head = columns.map(escapeCell).join(',');
  const body = rows.map((row) => columns.map((c) => escapeCell(row[c])).join(','));
  return [head, ...body].join('\r\n');
}

/** Parses CSV text into an array of objects keyed by the header row. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const src = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => {
    const obj = {};
    header.forEach((key, idx) => {
      obj[key] = r[idx] === undefined ? '' : r[idx];
    });
    return obj;
  });
}

/**
 * Browser-only: hand a CSV to the user. Guarded so the module stays importable in Node.
 *
 * Two delivery paths, because not every host lets a page start its own download:
 *  - a sandboxed host (the claude.ai artifact viewer) mediates saves through the
 *    `downloads` capability, where the viewer confirms the file;
 *  - everywhere else — including the Cloudflare Worker deployment — `claude.use` does not
 *    exist, and the ordinary anchor download runs.
 */
export async function downloadCsv(filename, columns, rows) {
  const csv = toCsv(columns, rows);
  if (typeof document === 'undefined') return csv;
  const withBom = `﻿${csv}`;

  try {
    const downloads = await globalThis.claude?.use?.('downloads');
    if (downloads) {
      await downloads.save({ filename, data: withBom });
      return csv;
    }
  } catch (err) {
    // The viewer declining is a normal outcome, not a failure to work around.
    if (err?.code === 'declined') return csv;
    console.warn('Host-mediated save unavailable, falling back to a direct download', err);
  }

  const blob = new Blob([withBom], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return csv;
}
