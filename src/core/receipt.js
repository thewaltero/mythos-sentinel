import path from 'node:path';
import { readJson, writeJson } from './fs.js';
import { createSnapshot, diffSnapshots } from './snapshot.js';
import { scanPath } from '../scanner/scan.js';
import { evaluateFindings } from './policy.js';

export async function createReceipt({ beforePath, afterPath, rootDir = '.', summary = '', agent = 'unknown', provider = 'unknown', tool = 'unknown', policy }) {
  const before = await readJson(beforePath);
  const after = afterPath ? await readJson(afterPath) : await createSnapshot(rootDir);
  const diff = diffSnapshots(before, after);
  const scan = await scanPath(rootDir, { policy });
  return {
    schema: 'https://mythos.dev/schemas/agent-receipt.v0.json',
    createdAt: new Date().toISOString(),
    agent: { name: agent, provider, tool },
    workspace: path.resolve(rootDir),
    summary,
    diff,
    verification: {
      scanner: 'mythos-sentinel',
      findingCount: scan.summary.findingCount,
      highestSeverity: scan.summary.highestSeverity,
      ok: scan.summary.ok
    },
    snapshots: {
      before,
      after
    }
  };
}

export async function writeReceipt(outPath, receipt) {
  await writeJson(outPath, receipt);
}

export async function verifyReceipt({ receiptPath, rootDir = '.', policy, failOn }) {
  const receipt = await readJson(receiptPath);
  if (!receipt.snapshots?.after?.files) throw new Error('Receipt is missing snapshots.after.files');
  const current = await createSnapshot(rootDir);
  const drift = diffSnapshots(receipt.snapshots.after, current);
  const scan = await scanPath(rootDir, { policy, failOn });
  const evaluation = evaluateFindings(scan.findings, policy, failOn);
  return {
    schema: 'https://mythos.dev/schemas/receipt-verification.v0.json',
    checkedAt: new Date().toISOString(),
    receipt: receiptPath,
    ok: drift.changedCount === 0 && evaluation.ok,
    drift,
    scanSummary: scan.summary,
    failingFindings: evaluation.failing
  };
}
