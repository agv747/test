#!/usr/bin/env node
/**
 * Generates placeholder shelf photos for the demo gallery.
 *
 * These stand in until real shelf photography is dropped into `public/demo-images/`.
 * The recognition simulator keys off the file identity, so any image — synthetic or a
 * real photo — produces a stable, plausible set of detections.
 *
 * Usage: node scripts/make-demo-images.mjs
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const OUT = resolve('public/demo-images');
await mkdir(OUT, { recursive: true });

const SHELVES = [
  {
    file: 'shelf-punggol-central.jpg',
    title: 'Punggol Central Minimart',
    rows: [
      ['L&M RED LINE XL', '13.70'],
      ['L&M BLUE LINE XL', '13.70'],
      ['COMPETITOR A VALUE', '13.50'],
      ['L&M DOUBLE FORWARD XL', '14.30'],
      ['COMPETITOR A CORE', '14.10'],
      ['COMPETITOR B PREMIUM', '16.10'],
    ],
  },
  {
    file: 'shelf-yishun-mini-mart.jpg',
    title: 'Yishun Mini Mart',
    rows: [
      ['L&M RED LINE XL', '14.00'],
      ['L&M GREEN LINE XL', '13.80'],
      ['COMPETITOR A VALUE', '13.70'],
      ['L&M RED LINE', '14.40'],
      ['COMPETITOR B CORE', '14.00'],
      ['COMPETITOR A PREMIUM', '15.80'],
    ],
  },
  {
    file: 'shelf-jurong-west.jpg',
    title: 'Jurong West Mini Mart',
    rows: [
      ['L&M BLUE LINE', '14.20'],
      ['L&M RED LINE XL', '13.60'],
      ['COMPETITOR B VALUE', '13.40'],
      ['L&M DOUBLE FORWARD XL', '14.50'],
      ['COMPETITOR A CORE', '13.60'],
      ['COMPETITOR B PREMIUM', '16.10'],
    ],
  },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1200, height: 1600 } });

for (const shelf of SHELVES) {
  await page.setContent(html(shelf));
  await page.screenshot({ path: `${OUT}/${shelf.file}`, type: 'jpeg', quality: 90 });
  console.log(`wrote ${shelf.file}`);
}

await browser.close();

function html({ title, rows }) {
  const packs = rows
    .map(
      ([name, price], i) => `
      <div class="bay">
        <div class="stack">${Array.from({ length: 5 }, (_, j) => `<div class="pack pack--${(i + j) % 4}"></div>`).join('')}</div>
        <div class="label">
          <div class="desc">${name}</div>
          <div class="price">$${price}</div>
        </div>
      </div>`,
    )
    .join('');

  return `<!doctype html><meta charset="utf-8"><style>
    body { margin:0; font-family: Arial, Helvetica, sans-serif; background:#2b2b30; }
    .shelf { padding:28px 24px; }
    .header { color:#cfd3d8; font-size:20px; letter-spacing:.14em; text-transform:uppercase; padding-bottom:18px; }
    .row { background:#3a3a41; border-radius:6px; padding:18px 14px 8px; margin-bottom:22px;
           box-shadow: inset 0 -14px 24px rgba(0,0,0,.35); display:flex; gap:14px; }
    .bay { flex:1; display:flex; flex-direction:column; gap:8px; }
    .stack { display:flex; gap:3px; height:150px; align-items:flex-end; }
    .pack { flex:1; border-radius:2px 2px 0 0; height:100%; box-shadow: 2px 0 4px rgba(0,0,0,.3); }
    .pack--0 { background:linear-gradient(180deg,#c8102e,#8e0b20); }
    .pack--1 { background:linear-gradient(180deg,#1d4e89,#123258); }
    .pack--2 { background:linear-gradient(180deg,#2e7d4f,#1d5033); }
    .pack--3 { background:linear-gradient(180deg,#d8d8d8,#a8a8a8); }
    .label { background:#f7f7f4; border-radius:3px; padding:6px 7px; min-height:56px; }
    .desc { font-size:11px; color:#222; font-weight:700; letter-spacing:.02em; line-height:1.2; }
    .price { font-size:22px; font-weight:800; color:#111; margin-top:3px; }
  </style>
  <div class="shelf">
    <div class="header">${title} — shelf reference photo</div>
    <div class="row">${packs}</div>
    <div class="row">${packs}</div>
    <div class="row">${packs}</div>
  </div>`;
}
