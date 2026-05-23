import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir, exists } from './fs.js';
import { normalizeDomain } from './policy.js';
import { appendTelemetryEvent } from './telemetry.js';

export const X402_RECEIPTS_VERSION = '0.10';
export const DEFAULT_X402_RECEIPTS_DIR = '.mythos/x402';
export const DEFAULT_X402_RECEIPTS_FILE = 'receipts.jsonl';

const HEADER_KEYS = [
  'x-payment-response',
  'x-payment',
  'x402-receipt',
  'x402-payment-response',
  'payment-response',
  'payment'
];

export function x402ReceiptsPath(rootDir = process.cwd()) {
  return path.join(rootDir, DEFAULT_X402_RECEIPTS_DIR, DEFAULT_X402_RECEIPTS_FILE);
}

export async function ingestX402Receipt(input, { rootDir = process.cwd(), policy = {}, source = 'manual', store = true } = {}) {
  const receipt = normalizeX402Receipt(input, { source });
  if (store) {
    const file = x402ReceiptsPath(rootDir);
    await ensureDir(path.dirname(file));
    await fs.appendFile(file, `${JSON.stringify(receipt)}\n`, 'utf8');
    receipt.storePath = file;
  }

  const telemetry = await appendTelemetryEvent({
    rootDir,
    policy,
    event: receiptToTelemetryEvent(receipt)
  });

  return {
    ok: true,
    stored: Boolean(store),
    receipt,
    telemetry: { stored: telemetry.stored, reason: telemetry.reason || null }
  };
}

export async function ingestX402ReceiptFile(filePath, { rootDir = process.cwd(), policy = {}, source = 'file' } = {}) {
  const raw = await fs.readFile(path.resolve(rootDir, filePath), 'utf8');
  return ingestX402Receipt(parseReceiptInput(raw), { rootDir, policy, source });
}

export async function readX402Receipts({ rootDir = process.cwd(), limit = 500 } = {}) {
  const file = x402ReceiptsPath(rootDir);
  if (!(await exists(file))) return [];
  const raw = await fs.readFile(file, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const selected = Number.isFinite(Number(limit)) && Number(limit) > 0 ? lines.slice(-Number(limit)) : lines;
  const receipts = [];
  for (const line of selected) {
    try { receipts.push(JSON.parse(line)); } catch { /* ignore malformed local receipt line */ }
  }
  return receipts;
}

export async function summarizeX402Receipts({ rootDir = process.cwd(), limit = 5000 } = {}) {
  return summarizeReceiptList(await readX402Receipts({ rootDir, limit }));
}

export function summarizeReceiptList(receipts = []) {
  const byDomain = new Map();
  let settled = 0;
  let failed = 0;
  let pending = 0;
  let totalAmountUSDC = 0;

  for (const receipt of receipts) {
    const domain = receipt.domain || 'unknown.local';
    if (!byDomain.has(domain)) byDomain.set(domain, { domain, count: 0, settled: 0, failed: 0, pending: 0, totalAmountUSDC: 0, networks: new Set(), assets: new Set(), lastObservedAt: null });
    const item = byDomain.get(domain);
    item.count += 1;
    item.totalAmountUSDC += Number(receipt.amountUSDC || 0);
    item.networks.add(receipt.network || 'unknown');
    item.assets.add(receipt.asset || 'unknown');
    item.lastObservedAt = maxIso(item.lastObservedAt, receipt.observedAt);
    totalAmountUSDC += Number(receipt.amountUSDC || 0);
    if (receipt.settlementStatus === 'settled') { settled += 1; item.settled += 1; }
    else if (receipt.settlementStatus === 'failed') { failed += 1; item.failed += 1; }
    else { pending += 1; item.pending += 1; }
  }

  return {
    ok: true,
    receiptCount: receipts.length,
    settled,
    failed,
    pending,
    totalAmountUSDC,
    generatedAt: new Date().toISOString(),
    domains: [...byDomain.values()].map((item) => ({
      ...item,
      totalAmountUSDC: Number(item.totalAmountUSDC.toFixed(8)),
      networks: [...item.networks],
      assets: [...item.assets]
    })).sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain)),
    privacy: {
      localOnly: true,
      excludes: ['prompts', 'responses', 'private request bodies', 'secrets', 'private keys', 'wallet balances']
    }
  };
}

export function normalizeX402Receipt(input, { source = 'manual' } = {}) {
  const payload = parseReceiptInput(input);
  const extracted = extractReceiptPayload(payload);
  const endpoint = firstString(
    extracted.endpoint,
    extracted.resource,
    extracted.url,
    extracted.target,
    extracted.request?.url,
    extracted.response?.url,
    extracted.payment?.resource,
    extracted.x402?.resource
  );
  const domain = normalizeDomain(firstString(extracted.domain, domainFromUrl(endpoint), extracted.host, extracted.hostname, extracted.service?.domain));
  const amountUSDC = normalizeAmountUSDC(extracted);
  const settlementStatus = normalizeSettlementStatus(extracted);
  const receipt = {
    version: X402_RECEIPTS_VERSION,
    receiptId: '',
    source,
    domain: domain || 'unknown.local',
    endpoint: endpoint || null,
    resource: firstString(extracted.resource, extracted.payment?.resource, endpoint),
    amountUSDC,
    asset: firstString(extracted.asset, extracted.token, extracted.currency, extracted.payment?.asset, extracted.accepts?.[0]?.asset, 'USDC'),
    network: normalizeNetwork(firstString(extracted.network, extracted.chain, extracted.chainId, extracted.payment?.network, extracted.accepts?.[0]?.network, 'base')),
    payer: sanitizeAddress(firstString(extracted.payer, extracted.from, extracted.account, extracted.wallet, extracted.payment?.from)),
    payTo: sanitizeAddress(firstString(extracted.payTo, extracted.to, extracted.receiver, extracted.recipient, extracted.payment?.to)),
    facilitator: firstString(extracted.facilitator, extracted.facilitatorUrl, extracted.x402?.facilitator) || null,
    transactionHash: firstString(extracted.transactionHash, extracted.txHash, extracted.tx, extracted.hash, extracted.settlement?.txHash, extracted.payment?.txHash) || null,
    settlementStatus,
    settled: settlementStatus === 'settled',
    settledAt: firstString(extracted.settledAt, extracted.completedAt, extracted.settlement?.settledAt) || null,
    scheme: firstString(extracted.scheme, extracted.payment?.scheme, 'x402') || 'x402',
    paymentVersion: firstString(extracted.x402Version, extracted.paymentVersion, extracted.version) || null,
    latencyMs: numberOrNull(extracted.latencyMs, extracted.durationMs, extracted.timing?.latencyMs),
    observedAt: firstString(extracted.observedAt, extracted.timestamp, extracted.createdAt, new Date().toISOString()),
    metadata: sanitizeMetadata(extracted)
  };
  receipt.receiptId = receiptId(receipt);
  return receipt;
}

export function parseReceiptInput(input) {
  if (input === undefined || input === null || input === '') return {};
  if (typeof input === 'object' && !Buffer.isBuffer(input)) return input;
  const raw = Buffer.isBuffer(input) ? input.toString('utf8') : String(input).trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { /* continue */ }
  const decoded = tryDecodePaymentBlob(raw);
  if (decoded) return decoded;
  return { raw };
}

export function extractReceiptFromHeaders(headers = {}) {
  const normalized = {};
  if (headers instanceof Headers) {
    for (const [key, value] of headers.entries()) normalized[key.toLowerCase()] = value;
  } else {
    for (const [key, value] of Object.entries(headers || {})) normalized[String(key).toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  for (const key of HEADER_KEYS) {
    if (!normalized[key]) continue;
    return parseReceiptInput(normalized[key]);
  }
  return null;
}

export function receiptToTelemetryEvent(receipt = {}) {
  return {
    source: 'x402_receipt',
    mode: 'receipt_ingestion',
    domain: receipt.domain,
    endpoint: receipt.endpoint,
    decision: receipt.settlementStatus,
    ok: receipt.settlementStatus === 'settled' ? true : receipt.settlementStatus === 'failed' ? false : null,
    latencyMs: receipt.latencyMs,
    amountUSDC: receipt.amountUSDC,
    schemaOk: true,
    priceMatchedQuote: true,
    errorType: receipt.settlementStatus === 'failed' ? 'x402_settlement_failed' : null,
    observedAt: receipt.observedAt
  };
}

function extractReceiptPayload(payload) {
  if (payload?.headers) {
    const headerPayload = extractReceiptFromHeaders(payload.headers);
    if (headerPayload) return { ...payload, ...headerPayload };
  }
  if (payload?.receipt) return { ...payload, ...payload.receipt };
  if (payload?.paymentReceipt) return { ...payload, ...payload.paymentReceipt };
  if (payload?.paymentResponse) return { ...payload, ...parseReceiptInput(payload.paymentResponse) };
  if (payload?.raw) {
    const decoded = tryDecodePaymentBlob(payload.raw);
    if (decoded) return { ...payload, ...decoded };
  }
  return payload || {};
}

function tryDecodePaymentBlob(value) {
  const raw = String(value || '').trim();
  const candidates = [raw];
  if (/^[A-Za-z0-9+/=_-]+$/.test(raw) && raw.length > 12) {
    candidates.push(Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* ignore */ }
  }
  return null;
}

function normalizeAmountUSDC(payload = {}) {
  const amount = firstNumber(payload.amountUSDC, payload.amountUsd, payload.usdc, payload.priceUSDC, payload.price, payload.amount, payload.payment?.amount, payload.settlement?.amount, payload.accepts?.[0]?.amount);
  if (amount === null) return 0;
  const asset = String(firstString(payload.asset, payload.token, payload.currency, payload.accepts?.[0]?.asset, 'USDC')).toLowerCase();
  if (amount >= 1000 && /usdc|usd/.test(asset)) return Number((amount / 1_000_000).toFixed(8));
  return Number(amount.toFixed ? amount.toFixed(8) : Number(amount).toFixed(8));
}

function normalizeSettlementStatus(payload = {}) {
  const raw = String(firstString(payload.settlementStatus, payload.status, payload.state, payload.payment?.status, payload.settlement?.status) || '').toLowerCase();
  if (payload.settled === true || payload.success === true || ['settled', 'success', 'succeeded', 'paid', 'confirmed', 'complete', 'completed'].includes(raw)) return 'settled';
  if (payload.settled === false || payload.success === false || ['failed', 'reverted', 'declined', 'error'].includes(raw)) return 'failed';
  if (['pending', 'submitted', 'processing'].includes(raw)) return 'pending';
  return payload.transactionHash || payload.txHash || payload.hash ? 'settled' : 'unknown';
}

function sanitizeMetadata(payload = {}) {
  const allowed = {};
  const allowKeys = ['requestId', 'paymentId', 'chainId', 'type', 'method', 'statusCode', 'httpStatus', 'searchMethod'];
  for (const key of allowKeys) {
    if (payload[key] !== undefined) allowed[key] = payload[key];
  }
  return allowed;
}

function receiptId(receipt) {
  const stable = [receipt.domain, receipt.endpoint, receipt.amountUSDC, receipt.asset, receipt.network, receipt.transactionHash, receipt.observedAt].join('|');
  return `x402_${crypto.createHash('sha256').update(stable).digest('hex').slice(0, 24)}`;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function numberOrNull(...values) {
  const number = firstNumber(...values);
  return number === null ? null : Math.max(0, Math.round(number));
}

function sanitizeAddress(value) {
  const raw = firstString(value);
  if (!raw) return null;
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) return raw;
  return raw.slice(0, 96);
}

function domainFromUrl(value) {
  if (!value || typeof value !== 'string') return null;
  try { return new URL(value).hostname; } catch { return null; }
}

function normalizeNetwork(network) {
  const raw = String(network || '').toLowerCase();
  if (raw === 'eip155:8453' || raw === '8453') return 'base';
  if (raw === 'eip155:84532' || raw === '84532') return 'base-sepolia';
  if (raw === '1' || raw === 'eip155:1') return 'ethereum';
  return raw || 'base';
}

function maxIso(a, b) {
  if (!a) return b;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}
