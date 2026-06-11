import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, exists } from './fs.js';
import { normalizeDomain } from './policy.js';

/**
 * Persistent local spend ledger.
 *
 * This is Sentinel's own source of truth for "how much has been spent today".
 * Budget enforcement must never rely solely on caller-supplied running totals
 * (an agent being firewalled could always report 0). The proxy records every
 * payment intent it forwards, receipt ingestion records settled receipts, and
 * enforcement reads back the maximum of (ledger, caller-reported) so that
 * self-reporting can only ever tighten a decision — never loosen it.
 *
 * Accounting is intentionally conservative: if the same payment is observed
 * both as a forwarded intent and as an ingested receipt it may be counted
 * twice. Over-counting tightens the budget early; it never allows extra spend.
 * See THREAT_MODEL.md ("Spend accounting").
 */

export const SPEND_LEDGER_VERSION = '0.11';
export const DEFAULT_SPEND_DIR = '.mythos/spend';
export const DEFAULT_SPEND_FILE = 'ledger.json';
export const SPEND_LEDGER_RETENTION_DAYS = 35;
export const SPEND_TIERS = Object.freeze(['trusted', 'known', 'unknown']);

export function spendLedgerPath(rootDir = process.cwd()) {
  return path.join(rootDir, DEFAULT_SPEND_DIR, DEFAULT_SPEND_FILE);
}

export function utcDateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return utcDateKey(new Date());
  return d.toISOString().slice(0, 10);
}

function emptyLedger() {
  // `mandates` holds lifetime totals per mandate id (mandate caps are
  // lifetime caps, so these are never pruned with the daily buckets).
  return { version: SPEND_LEDGER_VERSION, days: {}, mandates: {} };
}

function emptyDay() {
  return { totalUSDC: 0, unknownUSDC: 0, byDomain: {}, entries: 0 };
}

function roundUSDC(value) {
  // Avoid floating-point drift accumulating in stored totals (6 decimal
  // places matches USDC's smallest on-chain unit).
  return Math.round(Number(value) * 1e6) / 1e6;
}

/**
 * Read the ledger from disk. A missing, unreadable, or corrupted ledger file
 * yields an empty ledger — corruption fails toward "no recorded spend", which
 * is then compensated by the max(ledger, caller) rule at the enforcement site
 * and surfaced via the returned `corrupted` flag for diagnostics.
 */
export async function readSpendLedger({ rootDir = process.cwd() } = {}) {
  const file = spendLedgerPath(rootDir);
  if (!(await exists(file))) return { ledger: emptyLedger(), corrupted: false };
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.days !== 'object' || parsed.days === null) {
      return { ledger: emptyLedger(), corrupted: true };
    }
    return {
      ledger: {
        version: parsed.version || SPEND_LEDGER_VERSION,
        days: parsed.days,
        mandates: (parsed.mandates && typeof parsed.mandates === 'object') ? parsed.mandates : {}
      },
      corrupted: false
    };
  } catch {
    return { ledger: emptyLedger(), corrupted: true };
  }
}

/**
 * Today's (or the given date's) recorded spend.
 * Returns { date, totalUSDC, unknownUSDC, byDomain, entries, corrupted }.
 */
export async function dailySpend({ rootDir = process.cwd(), date } = {}) {
  const key = utcDateKey(date);
  const { ledger, corrupted } = await readSpendLedger({ rootDir });
  const day = ledger.days[key] || emptyDay();
  return {
    date: key,
    totalUSDC: roundUSDC(day.totalUSDC || 0),
    unknownUSDC: roundUSDC(day.unknownUSDC || 0),
    byDomain: { ...(day.byDomain || {}) },
    entries: Number(day.entries || 0),
    corrupted
  };
}

/**
 * Record an amount of spend against today's bucket (or the given date).
 *
 * tier: 'trusted' | 'known' | 'unknown' — only 'unknown' contributes to the
 * unknown-tier sub-budget, mirroring checkPayment's enforcement tiers.
 *
 * The write is atomic (temp file + rename) so a crash mid-write cannot leave
 * a truncated ledger behind, and days older than the retention window are
 * pruned on every write.
 */
export async function recordSpend({
  rootDir = process.cwd(),
  domain,
  amountUSDC,
  tier = 'known',
  date,
  source = 'proxy',
  mandateId = null
} = {}) {
  const amount = Number(amountUSDC);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, recorded: false, reason: 'amount must be a positive finite number' };
  }
  const normalizedTier = SPEND_TIERS.includes(tier) ? tier : 'unknown';
  const normalizedDomain = normalizeDomain(domain) || 'unknown.local';
  const key = utcDateKey(date);

  const { ledger } = await readSpendLedger({ rootDir });
  const day = ledger.days[key] || emptyDay();
  day.totalUSDC = roundUSDC((day.totalUSDC || 0) + amount);
  if (normalizedTier === 'unknown') day.unknownUSDC = roundUSDC((day.unknownUSDC || 0) + amount);
  day.byDomain = day.byDomain || {};
  day.byDomain[normalizedDomain] = roundUSDC((day.byDomain[normalizedDomain] || 0) + amount);
  day.entries = Number(day.entries || 0) + 1;
  ledger.days[key] = day;
  if (mandateId) {
    ledger.mandates = ledger.mandates || {};
    ledger.mandates[mandateId] = roundUSDC((ledger.mandates[mandateId] || 0) + amount);
  }
  pruneOldDays(ledger, key);

  const file = spendLedgerPath(rootDir);
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);

  return {
    ok: true,
    recorded: true,
    date: key,
    domain: normalizedDomain,
    tier: normalizedTier,
    amountUSDC: roundUSDC(amount),
    dayTotalUSDC: day.totalUSDC,
    dayUnknownUSDC: day.unknownUSDC,
    mandateId: mandateId || null,
    mandateTotalUSDC: mandateId ? ledger.mandates[mandateId] : null,
    source
  };
}

function pruneOldDays(ledger, todayKey) {
  const cutoff = new Date(`${todayKey}T00:00:00Z`).getTime() - SPEND_LEDGER_RETENTION_DAYS * 86_400_000;
  for (const key of Object.keys(ledger.days)) {
    const t = new Date(`${key}T00:00:00Z`).getTime();
    if (!Number.isFinite(t) || t < cutoff) delete ledger.days[key];
  }
}

/**
 * Effective spend figures for enforcement: the maximum of what the ledger has
 * recorded and what the caller self-reported. Self-reporting can therefore
 * only tighten enforcement, never loosen it.
 */
export function effectiveSpend({ ledgerSpend, reportedDailyUSDC = 0, reportedUnknownDailyUSDC = 0 } = {}) {
  const ledgerDaily = Number(ledgerSpend?.totalUSDC || 0);
  const ledgerUnknown = Number(ledgerSpend?.unknownUSDC || 0);
  return {
    dailySpentUSDC: Math.max(ledgerDaily, Number(reportedDailyUSDC) || 0),
    unknownDailySpentUSDC: Math.max(ledgerUnknown, Number(reportedUnknownDailyUSDC) || 0)
  };
}

/** Lifetime total recorded against a mandate id (never pruned). */
export async function mandateSpend({ rootDir = process.cwd(), mandateId } = {}) {
  if (!mandateId) return 0;
  const { ledger } = await readSpendLedger({ rootDir });
  return Number(ledger.mandates?.[mandateId] || 0);
}
