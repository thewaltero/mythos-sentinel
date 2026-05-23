import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, exists } from './fs.js';
import { normalizeDomain, domainMatches } from './policy.js';
import { seedX402Services } from './routescore.js';

export const TELEMETRY_VERSION = '0.10';
export const DEFAULT_TELEMETRY_DIR = '.mythos/telemetry';
export const DEFAULT_EVENTS_FILE = 'events.jsonl';

export function telemetryEnabled(policy = {}) {
  return Boolean(policy?.routeScore?.telemetry?.enabled || policy?.telemetry?.enabled);
}

export function telemetryPrivacy(policy = {}) {
  const configured = policy?.routeScore?.telemetry || policy?.telemetry || {};
  return {
    enabled: telemetryEnabled(policy),
    anonymous: configured.anonymous !== false,
    localOnly: configured.localOnly !== false,
    collectPrompts: false,
    collectResponses: false,
    collectWalletBalances: false,
    storePath: configured.storePath || `${DEFAULT_TELEMETRY_DIR}/${DEFAULT_EVENTS_FILE}`,
    note: 'Local opt-in telemetry stores only sanitized endpoint reliability metadata. Prompts, responses, secrets, private files, and wallet balances are never collected.'
  };
}

export function telemetryPath(rootDir = process.cwd(), policy = {}) {
  const configured = policy?.routeScore?.telemetry?.storePath || policy?.telemetry?.storePath || `${DEFAULT_TELEMETRY_DIR}/${DEFAULT_EVENTS_FILE}`;
  return path.isAbsolute(configured) ? configured : path.join(rootDir, configured);
}

export async function setTelemetryEnabled({ rootDir = process.cwd(), policy, enabled }) {
  if (!policy || typeof policy !== 'object') throw new Error('Policy object is required.');
  policy.routeScore ||= {};
  policy.routeScore.telemetry ||= {};
  policy.routeScore.telemetry.enabled = Boolean(enabled);
  policy.routeScore.telemetry.anonymous = true;
  policy.routeScore.telemetry.localOnly = true;
  policy.routeScore.telemetry.collectPrompts = false;
  policy.routeScore.telemetry.collectResponses = false;
  policy.routeScore.telemetry.collectWalletBalances = false;
  policy.routeScore.telemetry.storePath ||= `${DEFAULT_TELEMETRY_DIR}/${DEFAULT_EVENTS_FILE}`;
  if (enabled) await ensureDir(path.dirname(telemetryPath(rootDir, policy)));
  return policy;
}

export async function appendTelemetryEvent({ rootDir = process.cwd(), policy = {}, event = {} } = {}) {
  if (!telemetryEnabled(policy)) {
    return { ok: true, stored: false, reason: 'telemetry_disabled', privacy: telemetryPrivacy(policy) };
  }

  const sanitized = sanitizeTelemetryEvent(event);
  const file = telemetryPath(rootDir, policy);
  await ensureDir(path.dirname(file));
  await fs.appendFile(file, `${JSON.stringify(sanitized)}\n`, 'utf8');
  return { ok: true, stored: true, path: file, event: sanitized, privacy: telemetryPrivacy(policy) };
}

export async function readTelemetryEvents({ rootDir = process.cwd(), policy = {}, limit = 1000 } = {}) {
  const file = telemetryPath(rootDir, policy);
  if (!(await exists(file))) return [];
  const raw = await fs.readFile(file, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const selected = Number.isFinite(Number(limit)) && Number(limit) > 0 ? lines.slice(-Number(limit)) : lines;
  const events = [];
  for (const line of selected) {
    try { events.push(JSON.parse(line)); } catch { /* ignore malformed local telemetry line */ }
  }
  return events;
}

export async function telemetrySummary({ rootDir = process.cwd(), policy = {}, services = seedX402Services, limit = 5000 } = {}) {
  const events = await readTelemetryEvents({ rootDir, policy, limit });
  return summarizeTelemetryEvents(events, services);
}

export function summarizeTelemetryEvents(events = [], services = seedX402Services) {
  const byKey = new Map();
  for (const event of events) {
    const key = event.serviceId || serviceIdForDomain(event.domain, services) || event.domain || 'unknown';
    if (!byKey.has(key)) byKey.set(key, emptyAggregate(key));
    const aggregate = byKey.get(key);
    aggregate.samples += 1;
    aggregate.successes += event.ok === true ? 1 : 0;
    aggregate.failures += event.ok === false ? 1 : 0;
    aggregate.schemaOk += event.schemaOk === true ? 1 : 0;
    aggregate.schemaSamples += event.schemaOk === null || event.schemaOk === undefined ? 0 : 1;
    aggregate.priceMatched += event.priceMatchedQuote === false ? 0 : 1;
    aggregate.priceSamples += event.priceMatchedQuote === null || event.priceMatchedQuote === undefined ? 0 : 1;
    aggregate.totalAmountUSDC += Number.isFinite(Number(event.amountUSDC)) ? Number(event.amountUSDC) : 0;
    if (Number.isFinite(Number(event.latencyMs))) aggregate.latencies.push(Number(event.latencyMs));
    if (event.domain && !aggregate.domains.includes(event.domain)) aggregate.domains.push(event.domain);
    if (event.category && !aggregate.categories.includes(event.category)) aggregate.categories.push(event.category);
    if (event.observedAt) aggregate.lastObservedAt = maxIso(aggregate.lastObservedAt, event.observedAt);
    if (event.ok === false) {
      aggregate.recentFailureCount += 1;
      if (event.errorType) aggregate.errorTypes[event.errorType] = (aggregate.errorTypes[event.errorType] || 0) + 1;
    }
  }

  const aggregates = [...byKey.values()].map(finalizeAggregate);
  const telemetry = {};
  for (const aggregate of aggregates) {
    telemetry[aggregate.serviceId || aggregate.key] = {
      successRate: aggregate.successRate,
      schemaSuccessRate: aggregate.schemaSuccessRate,
      medianLatencyMs: aggregate.medianLatencyMs,
      samples: aggregate.samples,
      recentFailureCount: aggregate.recentFailureCount,
      priceMatchedQuote: aggregate.priceMatchedQuote,
      lastObservedAt: aggregate.lastObservedAt,
      amountUSDC: aggregate.totalAmountUSDC
    };
  }

  return {
    ok: true,
    eventCount: events.length,
    generatedAt: new Date().toISOString(),
    aggregates,
    telemetry,
    privacy: {
      anonymous: true,
      localOnly: true,
      excludes: ['prompts', 'responses', 'secrets', 'private file contents', 'wallet balances']
    }
  };
}

export function sanitizeTelemetryEvent(event = {}) {
  const domain = normalizeDomain(event.domain || domainFromUrl(event.endpoint) || domainFromUrl(event.url) || 'unknown.local');
  const serviceId = event.serviceId || serviceIdForDomain(domain, seedX402Services) || null;
  return {
    version: TELEMETRY_VERSION,
    source: String(event.source || 'runtime').slice(0, 64),
    mode: String(event.mode || 'local').slice(0, 64),
    serviceId,
    domain,
    category: event.category ? String(event.category).slice(0, 64) : null,
    upstream: event.upstream ? String(event.upstream).slice(0, 128) : null,
    tool: event.tool ? String(event.tool).slice(0, 128) : null,
    decision: event.decision ? String(event.decision).slice(0, 64) : null,
    ok: event.ok === undefined ? null : Boolean(event.ok),
    latencyMs: Number.isFinite(Number(event.latencyMs)) ? Math.max(0, Math.round(Number(event.latencyMs))) : null,
    amountUSDC: Number.isFinite(Number(event.amountUSDC)) ? Math.max(0, Number(event.amountUSDC)) : 0,
    schemaOk: event.schemaOk === undefined ? null : Boolean(event.schemaOk),
    priceMatchedQuote: event.priceMatchedQuote === undefined ? null : Boolean(event.priceMatchedQuote),
    errorType: event.errorType ? String(event.errorType).slice(0, 96) : null,
    observedAt: event.observedAt || new Date().toISOString(),
    privacy: 'sanitized endpoint metadata only; no prompts/responses/secrets/wallet balances'
  };
}

export function serviceIdForDomain(domain, services = seedX402Services) {
  const normalized = normalizeDomain(domain);
  const match = services.find((service) => domainMatches(normalized, service.domain));
  return match?.id || null;
}

function emptyAggregate(key) {
  return {
    key,
    serviceId: key,
    domains: [],
    categories: [],
    samples: 0,
    successes: 0,
    failures: 0,
    schemaOk: 0,
    schemaSamples: 0,
    priceMatched: 0,
    priceSamples: 0,
    totalAmountUSDC: 0,
    latencies: [],
    recentFailureCount: 0,
    errorTypes: {},
    lastObservedAt: null
  };
}

function finalizeAggregate(aggregate) {
  const medianLatencyMs = median(aggregate.latencies);
  const successRate = aggregate.samples ? aggregate.successes / aggregate.samples : 0;
  const schemaSuccessRate = aggregate.schemaSamples ? aggregate.schemaOk / aggregate.schemaSamples : 1;
  const priceMatchedQuote = aggregate.priceSamples ? aggregate.priceMatched / aggregate.priceSamples >= 0.95 : true;
  return {
    ...aggregate,
    successRate,
    schemaSuccessRate,
    priceMatchedQuote,
    medianLatencyMs,
    averageAmountUSDC: aggregate.samples ? aggregate.totalAmountUSDC / aggregate.samples : 0,
    errorTypes: aggregate.errorTypes
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function maxIso(a, b) {
  if (!a) return b;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function domainFromUrl(value) {
  if (!value || typeof value !== 'string') return null;
  try { return new URL(value).hostname; } catch { return null; }
}
