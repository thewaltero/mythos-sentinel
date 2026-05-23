import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultPolicy } from '../src/core/policy.js';
import { ingestX402Receipt, normalizeX402Receipt, summarizeX402Receipts } from '../src/core/x402-receipts.js';
import { setTelemetryEnabled, telemetrySummary } from '../src/core/telemetry.js';

test('x402 receipt ingestion stores sanitized receipts and feeds telemetry when enabled', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mythos-x402-'));
  const policy = await setTelemetryEnabled({ rootDir: dir, policy: structuredClone(defaultPolicy), enabled: true });
  const input = {
    endpoint: 'https://api.exa.ai/search',
    amount: '5000',
    asset: 'USDC',
    network: 'eip155:8453',
    status: 'settled',
    txHash: '0xabc123',
    payer: '0x0000000000000000000000000000000000000001',
    response: { body: 'this should not be copied into metadata' }
  };
  const result = await ingestX402Receipt(input, { rootDir: dir, policy, source: 'test' });
  assert.equal(result.stored, true);
  assert.equal(result.receipt.domain, 'api.exa.ai');
  assert.equal(result.receipt.amountUSDC, 0.005);
  assert.equal(result.receipt.settlementStatus, 'settled');
  assert.equal(result.receipt.metadata.body, undefined);
  const summary = await summarizeX402Receipts({ rootDir: dir });
  assert.equal(summary.receiptCount, 1);
  assert.equal(summary.settled, 1);
  const telemetry = await telemetrySummary({ rootDir: dir, policy });
  assert.equal(telemetry.eventCount, 1);
});

test('x402 receipt normalizer parses base64 payment response style payloads', () => {
  const encoded = Buffer.from(JSON.stringify({ resource: 'https://api.example.com/tool', priceUSDC: 0.02, success: true, transactionHash: '0xdef' })).toString('base64');
  const receipt = normalizeX402Receipt({ headers: { 'x-payment-response': encoded } });
  assert.equal(receipt.domain, 'api.example.com');
  assert.equal(receipt.amountUSDC, 0.02);
  assert.equal(receipt.settlementStatus, 'settled');
});
