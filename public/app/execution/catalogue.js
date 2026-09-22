/** Synthetic catalogue using the SG master-data field layout. No market claims. */
export function buildDemoCatalogue() {
  return [...'ABCDEFGHIJKLMNO'].map((letter, index) => ({
    id: `TW-${letter}`, code: `TW-${letter}`, sku_code: `TW-${letter}`,
    name: `Demo product ${letter} · synthetic`, market: 'TW',
    brand_id: `demo-brand-${Math.floor(index / 5) + 1}`,
    brand_name: `Demo brand ${Math.floor(index / 5) + 1}`,
    pack_type: 'Synthetic test unit', units_per_pack: 1,
    active: true, synthetic: true, source: 'synthetic_test_data',
    gtin: null, market_verified: false,
    artworks: letter === 'A' ? ['TW-A-artwork-1', 'TW-A-artwork-2'] : [`TW-${letter}-artwork-1`],
  }));
}

/** Add demo records without replacing saved audits, plans or user-created products. */
export function upgradeDemoCatalogue(workspace) {
  if (!workspace?.demo) return workspace;
  workspace.catalogue ??= [];
  for (const record of buildDemoCatalogue()) {
    const existing = workspace.catalogue.find(sku => sku.id === record.id);
    if (!existing) workspace.catalogue.push(record);
    else if (existing.synthetic || existing.name === `Sample ${record.id.slice(3)} · synthetic pack`) {
      Object.assign(existing, record);
    }
  }
  return workspace;
}
