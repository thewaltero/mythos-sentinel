import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from './fs.js';
import { readX402Receipts } from './x402-receipts.js';
import { seedX402Services, serviceForDomain, scoreService } from './routescore.js';

/**
 * RouteScore public directory: an explicitly opt-in, sanitized export of
 * locally observed x402 service behavior — which paid services actually
 * deliver, settle, and behave — suitable for committing to a repo or
 * publishing as a static page.
 *
 * Sanitization rules (see THREAT_MODEL.md "Directory publishing"):
 * - Domain-level only. No endpoints, paths, query strings, request ids,
 *   tx hashes, wallet addresses, or per-request amounts.
 * - Aggregates only: counts, settle/fail rates, summed volume, first/last
 *   seen dates (day precision).
 * - Domains below --min-receipts are excluded so one-off probes are not
 *   published.
 *
 * Publishing is a manual command. Nothing is ever uploaded by Sentinel
 * itself; the output is a local file the user chooses to share.
 */

export const DIRECTORY_VERSION = '1';

export async function buildDirectory({ rootDir = process.cwd(), minReceipts = 3 } = {}) {
  const receipts = await readX402Receipts({ rootDir, limit: 0 });
  const byDomain = new Map();

  for (const receipt of receipts) {
    const domain = String(receipt.domain || 'unknown.local');
    if (domain === 'unknown.local' || domain === 'unknown-payment-domain.local') continue;
    const entry = byDomain.get(domain) || {
      domain,
      receipts: 0,
      settled: 0,
      failed: 0,
      pending: 0,
      volumeUSDC: 0,
      firstSeen: null,
      lastSeen: null
    };
    entry.receipts += 1;
    if (receipt.settlementStatus === 'settled') entry.settled += 1;
    else if (receipt.settlementStatus === 'failed') entry.failed += 1;
    else entry.pending += 1;
    if (Number.isFinite(Number(receipt.amountUSDC))) entry.volumeUSDC = round6(entry.volumeUSDC + Number(receipt.amountUSDC));
    const day = String(receipt.timestamp || receipt.createdAt || '').slice(0, 10) || null;
    if (day) {
      if (!entry.firstSeen || day < entry.firstSeen) entry.firstSeen = day;
      if (!entry.lastSeen || day > entry.lastSeen) entry.lastSeen = day;
    }
    byDomain.set(domain, entry);
  }

  const services = [];
  for (const entry of byDomain.values()) {
    if (entry.receipts < Number(minReceipts)) continue;
    const known = serviceForDomain(entry.domain, seedX402Services);
    services.push({
      domain: entry.domain,
      category: known?.category || null,
      routeScore: known ? scoreService(known).score : null,
      receipts: entry.receipts,
      settleRate: round3(entry.settled / entry.receipts),
      failRate: round3(entry.failed / entry.receipts),
      volumeUSDC: entry.volumeUSDC,
      firstSeen: entry.firstSeen,
      lastSeen: entry.lastSeen
    });
  }
  services.sort((a, b) => b.receipts - a.receipts || a.domain.localeCompare(b.domain));

  return {
    version: DIRECTORY_VERSION,
    generatedAt: new Date().toISOString(),
    generator: 'mythos-sentinel',
    minReceipts: Number(minReceipts),
    serviceCount: services.length,
    services
  };
}

export async function writeDirectory(directory, { rootDir = process.cwd(), outDir = '.mythos/directory' } = {}) {
  const dir = path.resolve(rootDir, outDir);
  await ensureDir(dir);
  const jsonPath = path.join(dir, 'directory.json');
  const mdPath = path.join(dir, 'DIRECTORY.md');
  await fs.writeFile(jsonPath, `${JSON.stringify(directory, null, 2)}\n`, 'utf8');
  await fs.writeFile(mdPath, renderMarkdown(directory), 'utf8');
  return { jsonPath, mdPath };
}

function renderMarkdown(directory) {
  const lines = [
    '# x402 Service Directory',
    '',
    `Locally observed service behavior, aggregated and sanitized by mythos-sentinel.`,
    `Generated ${directory.generatedAt} · ${directory.serviceCount} services · min ${directory.minReceipts} receipts each.`,
    '',
    '| Domain | Category | RouteScore | Receipts | Settle rate | Fail rate | Volume (USDC) | Last seen |',
    '|---|---|---|---|---|---|---|---|'
  ];
  for (const s of directory.services) {
    lines.push(`| ${s.domain} | ${s.category ?? '—'} | ${s.routeScore ?? '—'} | ${s.receipts} | ${pct(s.settleRate)} | ${pct(s.failRate)} | ${s.volumeUSDC} | ${s.lastSeen ?? '—'} |`);
  }
  lines.push('', 'Domain-level aggregates only — no endpoints, request ids, or per-request details. See THREAT_MODEL.md.', '');
  return lines.join('\n');
}

function pct(v) { return `${Math.round(Number(v) * 100)}%`; }
function round3(v) { return Math.round(Number(v) * 1000) / 1000; }
function round6(v) { return Math.round(Number(v) * 1e6) / 1e6; }
