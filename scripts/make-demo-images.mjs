#!/usr/bin/env node
/**
 * Generates placeholder capture images for the demo gallery.
 *
 * Two Singapore specifics shape what these look like:
 *
 *  - **Point-of-sale display ban** (since 1 August 2017): general retailers may not display
 *    tobacco products within the public's line of sight, and keep them in plain, undecorated
 *    storage. So what a TME can actually photograph is the price list and the pack faces
 *    inside an opened cabinet — not an open shelf.
 *  - **Standardised packaging** (since 1 July 2020): no logos or brand colours; the brand
 *    name appears in a standard font on a drab base, with graphic health warnings over most
 *    of the pack.
 *
 * These images therefore render drab standardised packs behind a price list, which is the
 * realistic capture for this market. Replace them with real photography when available —
 * the recognition simulator keys off file identity, so any image works.
 *
 * Usage: node scripts/make-demo-images.mjs
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const OUT = resolve('public/demo-images');
await mkdir(OUT, { recursive: true });

const CAPTURES = [
  {
    file: 'shelf-punggol-central.jpg',
    title: 'Punggol Central Minimart',
    code: 'SG-E-1042',
    rows: [
      ['WINSTON', 'Red', '13.60'],
      ['WINSTON', 'Blue', '13.60'],
      ['MEVIUS', 'Original', '14.50'],
      ['PALL MALL', 'Red', '13.30'],
      ['LUCKY STRIKE', 'Red', '14.30'],
      ['MARLBORO', 'Red', '16.00'],
    ],
  },
  {
    file: 'shelf-yishun-mini-mart.jpg',
    title: 'Yishun Mini Mart',
    code: 'SG-N-2011',
    rows: [
      ['WINSTON', 'Red', '14.00'],
      ['CAMEL', 'Filters', '12.90'],
      ['MEVIUS', 'Original', '14.40'],
      ['PALL MALL', 'Red', '13.70'],
      ['L&M', 'Red Label', '13.90'],
      ['DAVIDOFF', 'Classic', '15.80'],
    ],
  },
  {
    file: 'shelf-jurong-west.jpg',
    title: 'Jurong West Mini Mart',
    code: 'SG-W-3007',
    rows: [
      ['WINSTON', 'Blue', '13.50'],
      ['LD', 'Red', '12.60'],
      ['MEVIUS', 'Sky Blue', '14.60'],
      ['CHESTERFIELD', 'Red', '13.40'],
      ['DUNHILL', 'Fine Cut Red', '15.60'],
      ['MARLBORO', 'Gold', '16.00'],
    ],
  },
];

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
});
const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });

for (const capture of CAPTURES) {
  await page.setContent(html(capture));
  await page.screenshot({ path: `${OUT}/${capture.file}`, type: 'jpeg', quality: 90 });
  console.log(`wrote ${capture.file}`);
}

await browser.close();

function html({ title, code, rows }) {
  // Standardised packaging: drab brown base (Pantone 448C), brand name in a standard font,
  // graphic health warning occupying most of the face.
  const packs = rows
    .map(
      ([brand, variant]) => `
      <div class="pack">
        <div class="warning">SMOKING<br />KILLS</div>
        <div class="packname">${brand}<span>${variant}</span></div>
      </div>`,
    )
    .join('');

  const list = rows
    .map(
      ([brand, variant, price]) => `
      <tr>
        <td class="brand">${brand} <span>${variant}</span></td>
        <td class="dots"></td>
        <td class="price">$${price}</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html><meta charset="utf-8"><style>
    body { margin:0; font-family: Arial, Helvetica, sans-serif; background:#20232a; }
    .frame { padding:26px 24px; }
    .head { color:#c9ced6; font-size:15px; letter-spacing:.16em; text-transform:uppercase; }
    .head b { display:block; color:#fff; font-size:22px; letter-spacing:.04em; margin-top:3px; }
    .head i { font-style:normal; font-size:12px; color:#8f97a3; letter-spacing:.08em; }

    .cabinet { background:#33373f; border-radius:5px; margin-top:16px; padding:16px 14px 10px;
               box-shadow: inset 0 -18px 30px rgba(0,0,0,.4); display:flex; gap:9px; }
    .pack { flex:1; height:190px; border-radius:3px 3px 0 0; background:#6d6552;
            display:flex; flex-direction:column; justify-content:space-between;
            box-shadow: 3px 0 6px rgba(0,0,0,.35); overflow:hidden; }
    .warning { background:#141414; color:#fff; font-size:13px; font-weight:800; line-height:1.15;
               padding:10px 6px; text-align:center; letter-spacing:.04em; flex:1;
               display:flex; align-items:center; justify-content:center; }
    .packname { background:#6d6552; color:#efeade; font-size:11px; font-weight:700; padding:6px;
                text-align:center; letter-spacing:.03em; }
    .packname span { display:block; font-weight:400; font-size:10px; opacity:.85; }

    .board { background:#f7f6f1; border-radius:4px; margin-top:20px; padding:18px 22px 14px; }
    .board h2 { margin:0 0 4px; font-size:15px; letter-spacing:.14em; text-transform:uppercase; color:#333; }
    .board .sub { font-size:11px; color:#777; margin-bottom:12px; letter-spacing:.05em; }
    table { width:100%; border-collapse:collapse; }
    td { padding:7px 0; font-size:19px; vertical-align:baseline; border-bottom:1px solid #e3e0d8; }
    .brand { font-weight:700; color:#161616; letter-spacing:.02em; }
    .brand span { font-weight:400; color:#5a5a5a; }
    .dots { width:100%; }
    .price { text-align:right; font-weight:800; color:#111; white-space:nowrap; font-size:22px; }
    .foot { font-size:10px; color:#8a8a8a; margin-top:10px; letter-spacing:.04em; }
  </style>
  <div class="frame">
    <div class="head">Price capture
      <b>${title}</b>
      <i>${code} · Singapore · SGD</i>
    </div>
    <div class="cabinet">${packs}</div>
    <div class="board">
      <h2>Price list</h2>
      <div class="sub">Per pack of 20 · inclusive of duty and GST</div>
      <table>${list}</table>
      <div class="foot">Illustrative demo image — not a real retailer price list.</div>
    </div>
  </div>`;
}
