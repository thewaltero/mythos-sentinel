import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir, exists } from './fs.js';
import { normalizeDomain, domainMatches } from './policy.js';

/**
 * EIP-712 signed spend mandates.
 *
 * A mandate is a human-signed authorization for autonomous spend: scope
 * (domains/categories), per-request cap, total cap, validity window. Sentinel
 * enforces it locally and records every spend against the mandate id, so the
 * receipt trail can prove compliance with a specific signed authorization.
 *
 * Amounts are integers in micro-USDC (1 USDC = 1_000_000) so signatures cover
 * exact values with no floating point.
 *
 * What the signature proves — and what it does not — is documented in
 * THREAT_MODEL.md ("Signed spend mandates").
 */

export const MANDATE_VERSION = '1';
export const DEFAULT_MANDATES_DIR = '.mythos/mandates';
export const USDC_MICRO = 1_000_000;

export const MANDATE_DOMAIN = Object.freeze({
  name: 'MythosSentinel',
  version: MANDATE_VERSION
});

export const MANDATE_TYPES = Object.freeze({
  SpendMandate: [
    { name: 'mandateId', type: 'string' },
    { name: 'agent', type: 'string' },
    { name: 'scopeDomains', type: 'string' },
    { name: 'scopeCategories', type: 'string' },
    { name: 'maxPerRequestMicroUSDC', type: 'uint256' },
    { name: 'capMicroUSDC', type: 'uint256' },
    { name: 'notBefore', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
    { name: 'chainId', type: 'uint64' }
  ]
});

export function mandatesDir(rootDir = process.cwd()) {
  return path.join(rootDir, DEFAULT_MANDATES_DIR);
}

export function toMicroUSDC(usdc) {
  const n = Number(usdc);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid USDC amount: ${usdc}`);
  return BigInt(Math.round(n * USDC_MICRO));
}

export function fromMicroUSDC(micro) {
  return Number(BigInt(micro)) / USDC_MICRO;
}

async function loadEthers() {
  try {
    return await import('ethers');
  } catch {
    throw new Error('Signed mandates require the optional "ethers" dependency. Install it with: npm install ethers');
  }
}

function normalizeMandateFields({
  mandateId,
  agent = '',
  scopeDomains = '*',
  scopeCategories = '*',
  maxPerRequestUSDC,
  capUSDC,
  notBefore,
  expiry,
  chainId = 8453 // Base mainnet; informational scoping, not an on-chain tx
}) {
  if (!Number.isFinite(Number(expiry))) throw new Error('mandate requires an expiry (unix seconds)');
  return {
    mandateId: String(mandateId || crypto.randomUUID()),
    agent: String(agent || ''),
    scopeDomains: String(scopeDomains || '*'),
    scopeCategories: String(scopeCategories || '*'),
    maxPerRequestMicroUSDC: toMicroUSDC(maxPerRequestUSDC ?? 0).toString(),
    capMicroUSDC: toMicroUSDC(capUSDC ?? 0).toString(),
    notBefore: String(Math.floor(Number(notBefore ?? Math.floor(Date.now() / 1000)))),
    expiry: String(Math.floor(Number(expiry))),
    chainId: String(Math.floor(Number(chainId)))
  };
}

/**
 * Create and sign a mandate with the given private key. Returns the signed
 * record { mandate, signature, signer, signedAt } and writes it under
 * .mythos/mandates/<mandateId>.json unless { store: false }.
 *
 * The private key is used in-memory only and never written anywhere.
 */
export async function createMandate(fields, { privateKey, rootDir = process.cwd(), store = true } = {}) {
  if (!privateKey) throw new Error('createMandate requires a private key (use an env var; never commit keys)');
  const { Wallet } = await loadEthers();
  const mandate = normalizeMandateFields(fields);
  const wallet = new Wallet(privateKey);
  const signature = await wallet.signTypedData(MANDATE_DOMAIN, MANDATE_TYPES, mandate);
  const record = { version: MANDATE_VERSION, mandate, signature, signer: wallet.address, signedAt: new Date().toISOString() };
  if (store) {
    const dir = mandatesDir(rootDir);
    await ensureDir(dir);
    const file = path.join(dir, `${mandate.mandateId}.json`);
    await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    record.storePath = file;
  }
  return record;
}

/**
 * Verify a mandate record's signature and shape. Returns
 * { ok, signer, reasons } — signature validity only; temporal/scope/cap
 * checks live in checkMandate so callers can distinguish "forged" from
 * "expired".
 */
export async function verifyMandate(record) {
  const reasons = [];
  if (!record || typeof record !== 'object' || !record.mandate || !record.signature) {
    return { ok: false, signer: null, reasons: ['malformed mandate record'] };
  }
  try {
    const { verifyTypedData } = await loadEthers();
    const mandate = normalizeShapeForVerify(record.mandate);
    const recovered = verifyTypedData(MANDATE_DOMAIN, MANDATE_TYPES, mandate, record.signature);
    if (record.signer && recovered.toLowerCase() !== String(record.signer).toLowerCase()) {
      reasons.push(`signature recovers ${recovered}, record claims ${record.signer}`);
      return { ok: false, signer: recovered, reasons };
    }
    return { ok: true, signer: recovered, reasons: ['signature valid'] };
  } catch (error) {
    return { ok: false, signer: null, reasons: [`signature verification failed: ${error.message}`] };
  }
}

function normalizeShapeForVerify(mandate) {
  // Ensure numeric-ish fields are strings so they hash identically to signing.
  return {
    mandateId: String(mandate.mandateId ?? ''),
    agent: String(mandate.agent ?? ''),
    scopeDomains: String(mandate.scopeDomains ?? '*'),
    scopeCategories: String(mandate.scopeCategories ?? '*'),
    maxPerRequestMicroUSDC: String(mandate.maxPerRequestMicroUSDC ?? '0'),
    capMicroUSDC: String(mandate.capMicroUSDC ?? '0'),
    notBefore: String(mandate.notBefore ?? '0'),
    expiry: String(mandate.expiry ?? '0'),
    chainId: String(mandate.chainId ?? '0')
  };
}

function scopeListMatches(value, scope) {
  const patterns = String(scope || '*').split(',').map((s) => s.trim()).filter(Boolean);
  if (!patterns.length || patterns.includes('*')) return true;
  return patterns.some((pattern) => domainMatches(value, pattern) || value === pattern);
}

/**
 * Enforce a verified mandate against a proposed payment.
 * spentOnMandateUSDC is the ledger's lifetime total recorded against this
 * mandate id (see spend-ledger mandateSpend).
 */
export function checkMandate({ domain, category, amountUSDC, record, spentOnMandateUSDC = 0, now = Math.floor(Date.now() / 1000) }) {
  const reasons = [];
  const mandate = record?.mandate || {};
  const normalizedDomain = normalizeDomain(domain) || '';
  const amountMicro = toMicroUSDC(amountUSDC ?? 0);
  const spentMicro = toMicroUSDC(spentOnMandateUSDC ?? 0);
  const perRequest = BigInt(mandate.maxPerRequestMicroUSDC || '0');
  const cap = BigInt(mandate.capMicroUSDC || '0');
  const notBefore = Number(mandate.notBefore || 0);
  const expiry = Number(mandate.expiry || 0);

  if (now < notBefore) reasons.push(`mandate ${mandate.mandateId} not valid until ${new Date(notBefore * 1000).toISOString()}`);
  if (expiry && now > expiry) reasons.push(`mandate ${mandate.mandateId} expired at ${new Date(expiry * 1000).toISOString()}`);
  if (!scopeListMatches(normalizedDomain, mandate.scopeDomains)) reasons.push(`domain ${normalizedDomain} outside mandate scope (${mandate.scopeDomains})`);
  if (category && !scopeListMatches(String(category), mandate.scopeCategories)) reasons.push(`category ${category} outside mandate scope (${mandate.scopeCategories})`);
  if (perRequest > 0n && amountMicro > perRequest) reasons.push(`amount ${fromMicroUSDC(amountMicro)} USDC exceeds mandate per-request cap ${fromMicroUSDC(perRequest)}`);
  if (cap > 0n && spentMicro + amountMicro > cap) {
    reasons.push(`mandate spend ${fromMicroUSDC(spentMicro + amountMicro)} USDC would exceed mandate cap ${fromMicroUSDC(cap)} (already recorded: ${fromMicroUSDC(spentMicro)})`);
  }

  return reasons.length
    ? { ok: false, decision: 'block', mandateId: mandate.mandateId || null, reasons }
    : { ok: true, decision: 'allow', mandateId: mandate.mandateId || null, reasons: [`covered by mandate ${mandate.mandateId}`] };
}

/** Load all stored mandate records (unverified — verify before trusting). */
export async function loadMandates({ rootDir = process.cwd() } = {}) {
  const dir = mandatesDir(rootDir);
  if (!(await exists(dir))) return [];
  const records = [];
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      records.push(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')));
    } catch {
      // Unreadable mandate files are skipped; a corrupt mandate can only
      // remove spending authority, never grant it.
    }
  }
  return records;
}

/**
 * Find the first stored mandate that verifies and covers the payment.
 * Returns { record, check } or null. Verification happens per call: a
 * tampered mandate file simply stops granting authority.
 */
export async function findCoveringMandate({ domain, category, amountUSDC, rootDir = process.cwd(), mandateSpendLookup, now }) {
  const records = await loadMandates({ rootDir });
  for (const record of records) {
    const sig = await verifyMandate(record);
    if (!sig.ok) continue;
    const spent = mandateSpendLookup ? await mandateSpendLookup(record.mandate.mandateId) : 0;
    const check = checkMandate({ domain, category, amountUSDC, record, spentOnMandateUSDC: spent, now });
    if (check.ok) return { record, check };
  }
  return null;
}
