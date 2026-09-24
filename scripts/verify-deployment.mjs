import assert from 'node:assert/strict';

const expected = process.env.EXPECTED_COMMIT;
assert.match(expected ?? '', /^[a-f0-9]{40}$/, 'EXPECTED_COMMIT must be the deployed Git commit');
const endpoint = 'https://price-check.anton-grebelny.workers.dev/api/execution/session';
let lastError;
for (let attempt = 1; attempt <= 12; attempt++) {
  try {
    const response = await fetch(`${endpoint}?release=${expected}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, `Session API returned HTTP ${response.status}`);
    const session = await response.json();
    assert.equal(session.buildSha, expected, 'The active Worker does not report this release yet');
    assert.equal(session.authConfigured, true, 'Private access is not configured');
    assert.equal(session.databaseConfigured, true, 'D1 binding is missing');
    console.log(`Verified active Worker commit ${expected}`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    console.log(`Verification attempt ${attempt}/12: ${error.message}`);
    if (attempt < 12) await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
console.error('Deployment command completed, but production verification failed. Inspect the active deployment; no automatic rollback was performed.');
throw lastError;
