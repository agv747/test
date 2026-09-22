/** Presentation-only improvements for the synthetic demo; shared workspaces are unchanged. */
export function demoNavigation(path) {
  const items = [
    ['tw/overview', 'Overview'],
    ['tw/audits/new', 'New check'],
    ['tw/planograms', 'Demo library'],
    ['tw/issues', 'Review queue'],
  ];
  return `<nav class="demo-nav" aria-label="Demo workspace">${items.map(([route, label]) => `<a href="#/${route}"${path === route || (route === 'tw/planograms' && path.startsWith(`${route}/`)) ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
}

export function simplifyDemoMarkup(page, path, filters = {}) {
  if (path === 'tw/overview') {
    const active = Object.entries(filters).filter(([, value]) => value !== '' && value != null).length;
    page = page.replace('Know what is visible. Verify what changed.', 'Your demo at a glance')
      .replace('Current cabinet status, including stores that have not been visited.', 'Explore the sample results, or start a new test. All products and locations are synthetic.')
      .replace('+ Start audit', '+ New check')
      .replace('Cabinet coverage', 'Sample checks')
      .replace(/<div class="rei-filters">([\s\S]*?)<\/div>/, `<details class="demo-disclosure"${active ? ' open' : ''}><summary>Filter results${active ? ` · ${active} active` : ''}</summary><div class="rei-filters">$1</div></details>`);
  }
  if (path === 'tw/planograms') {
    page = page.replace('<section class="card rei-table-scroll"><h3>Demo catalogue', '<details class="card demo-disclosure demo-catalogue"><summary>Browse demo products</summary><section class="rei-table-scroll"><h3>Demo catalogue')
      .replace('</tbody></table></section>', '</tbody></table></section></details>')
      .replace('One approved reference for each capture', 'Demo library')
      .replace('Published versions are immutable. Assignments use capture time.', 'Sample products and reference files in one place. Open a reference to inspect it.')
      .replace('<div class="rei-audit-layout"><section class="card"><h3>Import a planogram draft', '<details class="demo-disclosure demo-import"><summary>Import files & advanced setup</summary><div class="rei-audit-layout"><section class="card"><h3>Import a planogram draft');
    if (page.includes('demo-import')) page += '</details>';
  }
  return page;
}
