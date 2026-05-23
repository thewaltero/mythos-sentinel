import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSnapshot } from '../src/core/snapshot.js';
import { writeJson } from '../src/core/fs.js';
import { createReceipt, verifyReceipt, writeReceipt } from '../src/core/receipt.js';
import { defaultPolicy } from '../src/core/policy.js';

test('receipt verifies when workspace has no drift', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mythos-receipt-'));
  await fs.writeFile(path.join(dir, 'index.js'), 'console.log("hello")\n');
  const before = await createSnapshot(dir);
  const beforePath = path.join(dir, 'before.json');
  await writeJson(beforePath, before);

  await fs.writeFile(path.join(dir, 'index.js'), 'console.log("hello world")\n');
  const receipt = await createReceipt({
    beforePath,
    rootDir: dir,
    summary: 'demo change',
    agent: 'test-agent',
    provider: 'test',
    tool: 'node-test',
    policy: { ...defaultPolicy, findings: { failOn: ['critical'], warnOn: ['medium'] } }
  });
  const receiptPath = path.join(os.tmpdir(), `mythos-receipt-${Date.now()}-${Math.random()}.json`);
  await writeReceipt(receiptPath, receipt);

  const result = await verifyReceipt({
    receiptPath,
    rootDir: dir,
    policy: { ...defaultPolicy, findings: { failOn: ['critical'], warnOn: ['medium'] } },
    failOn: 'critical'
  });
  assert.equal(result.ok, true);
  assert.equal(result.drift.changedCount, 0);
});
