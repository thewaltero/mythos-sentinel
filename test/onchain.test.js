import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import {
  createMandate,
  verifyMandate,
  checkMandate,
  findCoveringMandate,
  toMicroUSDC,
  fromMicroUSDC
} from '../src/core/mandates.js';
import { recordSpend, mandateSpend } from '../src/core/spend-ledger.js';
import {
  buildAttestationBundle,
  verifyAttestationBundle,
  signAttestationBundle,
  verifySignedAttestation,
  encodeEasData,
  merkleRoot,
  canonicalJson,
  sha256Hex
} from '../src/core/attest.js';
import { ingestX402Receipt } from '../src/core/x402-receipts.js';
import { buildDirectory } from '../src/core/directory.js';

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-onchain-'));
}

const KEY = Wallet.createRandom().privateKey;

// ── Mandates ─────────────────────────────────────────────────────────────────

test('mandate create → verify roundtrip; tampering invalidates', async () => {
  const rootDir = await tmpRoot();
  const record = await createMandate(
    { scopeDomains: 'api.example.com', maxPerRequestUSDC: 0.25, capUSDC: 5, expiry: Math.floor(Date.now() / 1000) + 3600 },
    { privateKey: KEY, rootDir }
  );
  assert.equal((await verifyMandate(record)).ok, true);

  const tampered = structuredClone(record);
  tampered.mandate.capMicroUSDC = toMicroUSDC(500).toString(); // raise own cap
  const result = await verifyMandate(tampered);
  assert.equal(result.ok, false, 'tampered cap must invalidate the signature');
});

test('mandate enforcement: expiry, scope, per-request, lifetime cap', async () => {
  const now = Math.floor(Date.now() / 1000);
  const record = await createMandate(
    { scopeDomains: 'api.example.com,*.trusted.io', scopeCategories: '*', maxPerRequestUSDC: 0.10, capUSDC: 1, notBefore: now - 10, expiry: now + 3600 },
    { privateKey: KEY, store: false }
  );

  // In scope, under caps → allow.
  assert.equal(checkMandate({ domain: 'api.example.com', amountUSDC: 0.05, record, spentOnMandateUSDC: 0, now }).ok, true);
  // Out of scope domain → block.
  assert.equal(checkMandate({ domain: 'evil.example', amountUSDC: 0.05, record, now }).ok, false);
  // Per-request cap → block.
  assert.equal(checkMandate({ domain: 'api.example.com', amountUSDC: 0.11, record, now }).ok, false);
  // Lifetime cap: 0.95 already spent + 0.06 > 1 → block.
  assert.equal(checkMandate({ domain: 'api.example.com', amountUSDC: 0.06, record, spentOnMandateUSDC: 0.95, now }).ok, false);
  // Expired → block.
  assert.equal(checkMandate({ domain: 'api.example.com', amountUSDC: 0.01, record, now: now + 7200 }).ok, false);
  // Not yet valid → block.
  assert.equal(checkMandate({ domain: 'api.example.com', amountUSDC: 0.01, record, now: now - 100 }).ok, false);
});

test('mandate lifetime spend accumulates in the ledger across days', async () => {
  const rootDir = await tmpRoot();
  await recordSpend({ rootDir, domain: 'a.example', amountUSDC: 0.4, mandateId: 'm-1', date: '2026-06-09T10:00:00Z' });
  await recordSpend({ rootDir, domain: 'a.example', amountUSDC: 0.3, mandateId: 'm-1', date: '2026-06-10T10:00:00Z' });
  await recordSpend({ rootDir, domain: 'a.example', amountUSDC: 0.2, date: '2026-06-10T11:00:00Z' }); // no mandate
  assert.equal(await mandateSpend({ rootDir, mandateId: 'm-1' }), 0.7);
  assert.equal(await mandateSpend({ rootDir, mandateId: 'missing' }), 0);
});

test('findCoveringMandate picks a valid covering mandate and respects recorded spend', async () => {
  const rootDir = await tmpRoot();
  const now = Math.floor(Date.now() / 1000);
  const record = await createMandate(
    { scopeDomains: 'api.example.com', maxPerRequestUSDC: 0.25, capUSDC: 0.5, expiry: now + 3600 },
    { privateKey: KEY, rootDir }
  );
  const lookup = (id) => mandateSpend({ rootDir, mandateId: id });

  const covered = await findCoveringMandate({ domain: 'api.example.com', amountUSDC: 0.2, rootDir, mandateSpendLookup: lookup });
  assert.ok(covered, 'should find covering mandate');
  assert.equal(covered.record.mandate.mandateId, record.mandate.mandateId);

  // Exhaust the cap in the ledger; the same payment no longer fits.
  await recordSpend({ rootDir, domain: 'api.example.com', amountUSDC: 0.45, mandateId: record.mandate.mandateId });
  const exhausted = await findCoveringMandate({ domain: 'api.example.com', amountUSDC: 0.2, rootDir, mandateSpendLookup: lookup });
  assert.equal(exhausted, null, 'exhausted mandate must not cover new spend');
});

test('micro-USDC conversion is exact', () => {
  assert.equal(toMicroUSDC(0.25).toString(), '250000');
  assert.equal(fromMicroUSDC(250000n), 0.25);
  assert.equal(toMicroUSDC(5).toString(), '5000000');
});

// ── Attestation ──────────────────────────────────────────────────────────────

test('attestation bundle is deterministic and tamper-evident', async () => {
  const rootDir = await tmpRoot();
  await ingestX402Receipt({ url: 'https://api.example.com/paid', amountUSDC: 0.05, status: 'settled' }, { rootDir });
  const extra = path.join(rootDir, 'mythos-receipt.json');
  await fs.writeFile(extra, JSON.stringify({ summary: 'agent task', after: 'deadbeef' }), 'utf8');

  const bundle = await buildAttestationBundle({ rootDir, includePaths: [extra] });
  assert.equal(bundle.itemCount, 3); // x402 receipt + ledger day + file
  assert.match(bundle.merkleRoot, /^0x[0-9a-f]{64}$/);
  assert.match(bundle.bundleHash, /^0x[0-9a-f]{64}$/);
  assert.equal(verifyAttestationBundle(bundle).ok, true);

  const tampered = structuredClone(bundle);
  tampered.items[0] = { ...tampered.items[0], sha256: sha256Hex('forged') };
  assert.equal(verifyAttestationBundle(tampered).ok, false, 'tampered item must fail verification');
});

test('merkle root is order-independent over the same leaves', () => {
  const leaves = [sha256Hex('a'), sha256Hex('b'), sha256Hex('c')];
  assert.equal(merkleRoot(leaves), merkleRoot([...leaves].reverse()));
  assert.notEqual(merkleRoot(leaves), merkleRoot(leaves.slice(0, 2)));
});

test('canonical JSON is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
});

test('attestation off-chain sign → verify roundtrip; forged signer rejected', async () => {
  const rootDir = await tmpRoot();
  const bundle = await buildAttestationBundle({ rootDir });
  const signed = await signAttestationBundle(bundle, { privateKey: KEY });
  assert.equal((await verifySignedAttestation(signed)).ok, true);

  const forged = { ...signed, signer: Wallet.createRandom().address };
  assert.equal((await verifySignedAttestation(forged)).ok, false);
});

test('EAS data encodes to ABI hex', async () => {
  const rootDir = await tmpRoot();
  const bundle = await buildAttestationBundle({ rootDir });
  const data = await encodeEasData(bundle);
  assert.match(data, /^0x[0-9a-f]+$/);
  assert.ok(data.length > 200, 'encoded payload should contain all fields');
});

// ── Directory ────────────────────────────────────────────────────────────────

test('directory aggregates per domain, sanitized, with min-receipts filter', async () => {
  const rootDir = await tmpRoot();
  for (let i = 0; i < 3; i++) {
    await ingestX402Receipt({ url: `https://api.good.example/v1/things?id=${i}&token=secret`, amountUSDC: 0.05, status: 'settled' }, { rootDir });
  }
  await ingestX402Receipt({ url: 'https://api.flaky.example/x', amountUSDC: 0.05, status: 'failed' }, { rootDir });

  const directory = await buildDirectory({ rootDir, minReceipts: 3 });
  assert.equal(directory.serviceCount, 1, 'flaky.example has < 3 receipts and must be excluded');
  const svc = directory.services[0];
  assert.equal(svc.domain, 'api.good.example');
  assert.equal(svc.receipts, 3);
  assert.equal(svc.settleRate, 1);
  assert.equal(svc.volumeUSDC, 0.15);

  // Sanitization: no endpoint paths, query strings, or secrets anywhere.
  const serialized = JSON.stringify(directory);
  assert.ok(!serialized.includes('/v1/things'), 'endpoint path leaked');
  assert.ok(!serialized.includes('token=secret'), 'query string leaked');
  assert.ok(!serialized.includes('receiptId'), 'per-request identifier leaked');
});

// ── Proxy integration: requireMandate end-to-end ─────────────────────────────

test('proxy holds payments without a mandate, forwards with one, attributes spend', async (t) => {
  const { McpProxy } = await import('../src/mcp/proxy.js');
  const { loadPolicy } = await import('../src/core/policy.js');
  const { dailySpend, readSpendLedger } = await import('../src/core/spend-ledger.js');

  const rootDir = await tmpRoot();
  const policy = structuredClone((await import('../src/core/policy.js')).defaultPolicy);
  policy.payments.x402.requireMandate = true;

  let forwarded = 0;
  const fakeClient = { id: 'fake', callTool: async () => { forwarded += 1; return { content: [{ type: 'text', text: 'ok' }], isError: false }; } };
  const proxy = new McpProxy({ policy, proxyConfig: { upstreams: [] }, rootDir });
  proxy.initialized = true;
  proxy.toolIndex.set('x402_pay', { tool: { name: 'x402_pay' }, publicName: 'x402_pay', upstreamName: 'x402_pay', client: fakeClient });

  const args = { url: 'https://api.coinbase.com/paid', amountUSDC: 0.05 };

  // 1. No mandate → held for approval, nothing forwarded, nothing recorded.
  const held = await proxy.callTool('x402_pay', args);
  assert.ok(JSON.stringify(held).includes('mandate'), 'hold reason should mention the missing mandate');
  assert.equal(forwarded, 0);
  assert.equal((await dailySpend({ rootDir })).totalUSDC, 0);

  // 2. Create a covering mandate → forwarded and recorded against it.
  const record = await createMandate(
    { scopeDomains: 'api.coinbase.com', maxPerRequestUSDC: 0.25, capUSDC: 1, expiry: Math.floor(Date.now() / 1000) + 3600 },
    { privateKey: KEY, rootDir }
  );
  const allowed = await proxy.callTool('x402_pay', args);
  assert.equal(forwarded, 1, 'covered payment must be forwarded');
  assert.ok(!JSON.stringify(allowed).includes('approval_required'));
  assert.equal((await dailySpend({ rootDir })).totalUSDC, 0.05);
  const { ledger } = await readSpendLedger({ rootDir });
  assert.equal(ledger.mandates[record.mandate.mandateId], 0.05, 'spend must be attributed to the mandate');
});

test('verify succeeds on a stored bundle after signing attaches envelope fields', async () => {
  const rootDir = await tmpRoot();
  const bundle = await buildAttestationBundle({ rootDir });
  bundle.signed = await signAttestationBundle(bundle, { privateKey: KEY });
  bundle.onchain = { ok: true, txHash: '0xabc', network: 'base-sepolia' };
  // Round-trip through JSON like the stored file does.
  const reloaded = JSON.parse(JSON.stringify(bundle));
  assert.equal(verifyAttestationBundle(reloaded).ok, true, 'envelope fields must not break the hash commitment');
  assert.equal((await verifySignedAttestation(reloaded.signed)).ok, true);
});
