#!/usr/bin/env node
/**
 * Builds a single self-contained HTML file containing the whole application.
 *
 * The Cloudflare Worker in `public/` is the real deployment target; this build exists so
 * the app can be opened, shared or archived as one file with no server at all — useful for
 * a demo on a machine that cannot reach the deployment, or for embedding in a review tool.
 *
 * Everything is inlined: the JS module graph (bundled by esbuild), the stylesheet, and the
 * sample shelf photos as data URIs. There are no network requests at runtime.
 *
 * Usage:
 *   node scripts/bundle-standalone.mjs [outFile]
 *   node scripts/bundle-standalone.mjs [outFile] --artifact
 *
 * `--artifact` emits the same page without the outer <!doctype>/<html>/<head>/<body>
 * wrapper, for hosts that supply their own document skeleton.
 */

import { build } from 'esbuild';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const ARTIFACT_MODE = args.includes('--artifact');
const OUT = resolve(args.find((a) => !a.startsWith('--')) ?? 'dist/retail-price-intelligence.html');
const PUBLIC = resolve('public');

/* --------------------------------------------------------- sample images */

const imageDir = resolve(PUBLIC, 'demo-images');
const LABELS = {
  'shelf-punggol-central.jpg': 'Punggol',
  'shelf-yishun-mini-mart.jpg': 'Yishun',
  'shelf-jurong-west.jpg': 'Jurong West',
};

const files = (await readdir(imageDir)).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
const embedded = [];
for (const file of files) {
  const bytes = await readFile(resolve(imageDir, file));
  embedded.push({
    label: LABELS[file] ?? file.replace(/\.[^.]+$/, ''),
    file,
    url: `data:image/jpeg;base64,${bytes.toString('base64')}`,
  });
}

/* ------------------------------------------------------------- JS bundle */

const result = await build({
  entryPoints: [resolve(PUBLIC, 'app/main.js')],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: true,
  write: false,
  legalComments: 'none',
  // `start()` is called by the inline boot script below.
  globalName: 'RPI',
});
const js = result.outputFiles[0].text;

/* ------------------------------------------------------------------ CSS */

const css = await readFile(resolve(PUBLIC, 'styles/app.css'), 'utf8');

/* ----------------------------------------------------------------- HTML */

/** The page body — identical in both modes. */
const page = `<div id="root"></div>
<script>
  // Sample shelf photos, embedded so the gallery flow works with no network.
  globalThis.__RPI_EMBEDDED_IMAGES__ = ${JSON.stringify(embedded)};
</script>
<script>
${js}
  RPI.start();
</script>
<noscript><p style="padding:24px;font-family:sans-serif">This application requires JavaScript.</p></noscript>
`;

const html = ARTIFACT_MODE
  ? `<title>Retail Price Intelligence SG</title>
<style>
${css}
</style>
${page}`
  : `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#0f3d2e" />
    <meta name="description" content="Retail Price Intelligence — Singapore. Field price capture and manager decision support for observed retail price position." />
    <title>Retail Price Intelligence SG</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230f3d2e'/%3E%3Cpath d='M8 22V13M14 22V9M20 22V16M26 22V11' stroke='%23fff' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E" />
    <style>
${css}
    </style>
  </head>
  <body>
${page}  </body>
</html>
`;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, html, 'utf8');

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`Wrote ${OUT}`);
console.log(`  JS bundle    ${kb(js.length)}`);
console.log(`  CSS          ${kb(css.length)}`);
console.log(`  ${embedded.length} sample images  ${kb(embedded.reduce((a, e) => a + e.url.length, 0))}`);
console.log(`  Total        ${kb(html.length)}`);
