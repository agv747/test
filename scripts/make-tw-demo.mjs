import { mkdir, writeFile } from 'node:fs/promises';
import { cabinetSvg, buildTaiwanDemo } from '../public/app/execution/demo.js';
await mkdir(new URL('../public/demo/tw/', import.meta.url), { recursive: true });
for (const id of ['F1', 'F2', 'F3']) await writeFile(new URL(`../public/demo/tw/${id}.svg`, import.meta.url), cabinetSvg(id));
const w = buildTaiwanDemo();
await writeFile(new URL('../public/demo/tw/planogram.json', import.meta.url), JSON.stringify(w.plans[0], null, 2) + '\n');
await writeFile(new URL('../public/demo/tw/setup.json', import.meta.url), JSON.stringify({ catalogue: w.catalogue, fixtures: w.fixtures }, null, 2) + '\n');
console.log(`Generated three cabinet schematics and import examples: ${w.catalogue.length} catalogue records, ${w.plans[0].slots.length} plan slots.`);
