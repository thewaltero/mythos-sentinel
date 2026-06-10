import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  dailySpend,
  effectiveSpend,
  readSpendLedger,
  recordSpend,
  spendLedgerPath,
  utcDateKey
} from '../src/core/spend-ledger.js';
import { evaluateToolCall } from '../src/mcp/proxy.js';
import { defaultPolicy } from '../src/core/policy.js';
import { ingestX402Receipt } from '../src/core/x402-receipts.js';

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-ledger-'));
}

test('recordSpend accumulates totals, domains, and unknown tier', async () => {
  const rootDir = await tmpRoot();
  await recordSpend({ rootDir, domain: 'api.example.com', amountUSDC: 0.10, tier: 'known' });
  await recordSpend({ rootDir, domain: 'api.example.com', amountUSDC: 0.05, tier: 'known' });
  await recordSpend({ rootDir, domain: 'sketchy.example', amountUSDC: 0.02, tier: 'unknown' });

  const today = await dailySpend({ rootDir });
  assert.equal(today.totalUSDC, 0.17);
  assert.equal(today.unknownUSDC, 0.02);
  assert.equal(today.byDomain['api.example.com'], 0.15);
  assert.equal(today.byDomain['sketchy.example'], 0.02);
  assert.equal(today.entries, 3);
});

test('recordSpend rejects non-positive and non-finite amounts', async () => {
  const rootDir = await tmpRoot();
  assert.equal((await recordSpend({ rootDir, domain: 'a.example', amountUSDC: 0 })).recorded, false);
  assert.equal((await recordSpend({ rootDir, domain: 'a.example', amountUSDC: -1 })).recorded, false);
  assert.equal((await recordSpend({ rootDir, domain: 'a.example', amountUSDC: 'nope' })).recorded, false);
  const today = await dailySpend({ rootDir });
  assert.equal(today.totalUSDC, 0);
});

test('corrupted ledger reads as empty and is flagged', async () => {
  const rootDir = await tmpRoot();
  const file = spendLedgerPath(rootDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{not json', 'utf8');
  const { corrupted } = await readSpendLedger({ rootDir });
  assert.equal(corrupted, true);
  const today = await dailySpend({ rootDir });
  assert.equal(today.totalUSDC, 0);
  assert.equal(today.corrupted, true);
  // Recording over a corrupted file recovers cleanly.
  const result = await recordSpend({ rootDir, domain: 'a.example', amountUSDC: 0.01 });
  assert.equal(result.ok, true);
  assert.equal((await dailySpend({ rootDir })).corrupted, false);
});

test('spend is bucketed per UTC day', async () => {
  const rootDir = await tmpRoot();
  await recordSpend({ rootDir, domain: 'a.example', amountUSDC: 0.50, date: '2026-06-09T12:00:00Z' });
  await recordSpend({ rootDir, domain: 'a.example', amountUSDC: 0.25, date: '2026-06-10T12:00:00Z' });
  assert.equal((await dailySpend({ rootDir, date: '2026-06-09' })).totalUSDC, 0.5);
  assert.equal((await dailySpend({ rootDir, date: '2026-06-10' })).totalUSDC, 0.25);
  assert.equal(utcDateKey('2026-06-09T23:59:59Z'), '2026-06-09');
});

test('effectiveSpend takes the max of ledger and self-reported figures', () => {
  const ledgerSpend = { totalUSDC: 4.5, unknownUSDC: 0.2 };
  // Agent under-reports: ledger wins.
  let eff = effectiveSpend({ ledgerSpend, reportedDailyUSDC: 0, reportedUnknownDailyUSDC: 0 });
  assert.equal(eff.dailySpentUSDC, 4.5);
  assert.equal(eff.unknownDailySpentUSDC, 0.2);
  // Agent over-reports: the report wins (tightens early).
  eff = effectiveSpend({ ledgerSpend, reportedDailyUSDC: 9, reportedUnknownDailyUSDC: 1 });
  assert.equal(eff.dailySpentUSDC, 9);
  assert.equal(eff.unknownDailySpentUSDC, 1);
});

test('proxy budget enforcement cannot be reset by self-reporting zero', () => {
  const policy = structuredClone(defaultPolicy);
  // maxDailyUSDC default is 5. Ledger says 4.99 already spent today.
  const spend = { totalUSDC: 4.99, unknownUSDC: 0 };
  const decision = evaluateToolCall({
    toolName: 'x402_pay',
    args: { url: 'https://api.coinbase.com/paid', amountUSDC: 0.05, dailySpentUSDC: 0 },
    policy,
    spend
  });
  // 4.99 + 0.05 exceeds the 5 USDC daily cap even though the caller reported 0.
  assert.notEqual(decision.decision, 'allow');
  assert.ok(decision.reasons.join(' ').toLowerCase().includes('daily'));
});

test('settled x402 receipts are recorded into the ledger; failed ones are not', async () => {
  const rootDir = await tmpRoot();
  const settled = await ingestX402Receipt(
    { url: 'https://api.example.com/paid', amountUSDC: 0.07, status: 'settled' },
    { rootDir, store: false }
  );
  assert.equal(settled.ledger.recorded, true);
  const failed = await ingestX402Receipt(
    { url: 'https://api.example.com/paid', amountUSDC: 0.07, status: 'failed' },
    { rootDir, store: false }
  );
  assert.equal(failed.ledger.recorded, false);
  const today = await dailySpend({ rootDir });
  assert.equal(today.totalUSDC, 0.07);
});
