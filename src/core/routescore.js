import fs from 'node:fs/promises';
import path from 'node:path';
import { exists, ensureDir, writeJson, readJson } from './fs.js';
import { domainMatches, normalizeDomain } from './policy.js';

export const ROUTESCORE_VERSION = '0.10';
export const ROUTESCORE_DIR = '.mythos/routescore';
export const ROUTESCORE_SERVICES_FILE = 'services.json';
export const CDP_BAZAAR_RESOURCES_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
export const CDP_BAZAAR_SEARCH_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/search';


export const SERVICE_CATEGORIES = Object.freeze({
  web_search: { label: 'Web search', aliases: ['search', 'serp', 'research'] },
  content_extraction: { label: 'Content extraction', aliases: ['content', 'extract', 'reader', 'crawl', 'scrape'] },
  browser: { label: 'Browser automation', aliases: ['browser_session', 'browserbase', 'navigate'] },
  scraping: { label: 'Scraping', aliases: ['scraper', 'crawler'] },
  market_data: { label: 'Market data', aliases: ['prices', 'quotes', 'news', 'ticker'] },
  wallet_intel: { label: 'Wallet intelligence', aliases: ['wallet', 'risk', 'holders', 'address_intel'] },
  web3_data: { label: 'Web3 data', aliases: ['rpc', 'chain_data', 'contract_data', 'token_data'] },
  inference: { label: 'AI inference', aliases: ['llm', 'model', 'chat', 'completion'] },
  image_generation: { label: 'Image generation', aliases: ['image', 'vision', 'creative'] },
  code_execution: { label: 'Code execution', aliases: ['code', 'sandbox', 'runtime'] },
  storage: { label: 'Storage', aliases: ['files', 'blob', 'ipfs'] },
  identity: { label: 'Identity', aliases: ['auth', 'attestation', 'profile'] },
  messaging: { label: 'Messaging', aliases: ['email', 'sms', 'notifications'] },
  payments: { label: 'Payments', aliases: ['payment', 'settlement', 'wallet'] },
  general: { label: 'General', aliases: ['utility', 'tool'] }
});

export function listServiceCategories() {
  return Object.entries(SERVICE_CATEGORIES).map(([id, meta]) => ({ id, ...meta }));
}

export const seedX402Services = Object.freeze([
  {
    id: 'exa-search',
    name: 'Exa Search',
    category: 'web_search',
    domain: 'api.exa.ai',
    endpoint: 'https://api.exa.ai/search',
    network: 'base',
    priceUSDC: 0.005,
    status: 'seed',
    source: 'seed',
    tags: ['search', 'research', 'agent-memory'],
    note: 'Documented x402 search endpoint. Use as a seed service; refresh live metadata from Bazaar in production.'
  },
  {
    id: 'exa-contents',
    name: 'Exa Contents',
    category: 'content_extraction',
    domain: 'api.exa.ai',
    endpoint: 'https://api.exa.ai/contents',
    network: 'base',
    priceUSDC: 0.01,
    status: 'seed',
    source: 'seed',
    tags: ['content', 'url-extraction', 'research'],
    note: 'Documented x402 contents endpoint. Good first class for schema and latency checks.'
  },
  {
    id: 'venice-inference',
    name: 'Venice AI',
    category: 'inference',
    domain: 'api.venice.ai',
    endpoint: 'https://api.venice.ai',
    network: 'base',
    priceUSDC: 0.02,
    status: 'watchlist',
    source: 'seed',
    tags: ['inference', 'image', 'code'],
    note: 'Ecosystem-listed service. Treat as watchlist until live x402 metadata is verified.'
  },
  {
    id: 'alchemy-web3',
    name: 'Alchemy Web3 API',
    category: 'web3_data',
    domain: 'alchemy.com',
    endpoint: 'https://alchemy.com',
    network: 'base',
    priceUSDC: 0.02,
    status: 'watchlist',
    source: 'seed',
    tags: ['rpc', 'web3-data', 'base'],
    note: 'Ecosystem-listed service. Replace with live payable endpoint from Bazaar before production routing.'
  },
  {
    id: 'nansen-wallet-intel',
    name: 'Nansen Wallet Intelligence',
    category: 'wallet_intel',
    domain: 'nansen.ai',
    endpoint: 'https://nansen.ai',
    network: 'base',
    priceUSDC: 0.05,
    status: 'watchlist',
    source: 'seed',
    tags: ['wallets', 'analytics', 'risk'],
    note: 'Ecosystem-listed service. Useful category for future spend decisions; verify endpoint before auto-routing.'
  }
]);

const DEFAULT_TELEMETRY = Object.freeze({
  successRate: 0.92,
  schemaSuccessRate: 0.9,
  medianLatencyMs: 1200,
  quoteLatencyMs: 220,
  samples: 0,
  lastCheckedMinutesAgo: null,
  priceMatchedQuote: true,
  recentFailureCount: 0
});

export function routeScoreServicesPath(rootDir = process.cwd()) {
  return path.join(rootDir, ROUTESCORE_DIR, ROUTESCORE_SERVICES_FILE);
}

export async function loadCustomServices({ rootDir = process.cwd(), filePath } = {}) {
  const target = filePath ? path.resolve(rootDir, filePath) : routeScoreServicesPath(rootDir);
  if (!(await exists(target))) return [];
  const data = await readJson(target);
  return normalizeServiceList(Array.isArray(data) ? data : data.services || [], { source: 'custom' });
}

export async function saveCustomServices(services, { rootDir = process.cwd(), filePath, replace = true } = {}) {
  const target = filePath ? path.resolve(rootDir, filePath) : routeScoreServicesPath(rootDir);
  const normalized = normalizeServiceList(services, { source: 'custom' });
  let next = normalized;
  if (!replace && await exists(target)) {
    next = mergeServices(await loadCustomServices({ rootDir, filePath }), normalized);
  }
  await ensureDir(path.dirname(target));
  await writeJson(target, {
    version: ROUTESCORE_VERSION,
    generatedAt: new Date().toISOString(),
    services: next
  });
  return { ok: true, path: target, services: next, count: next.length };
}

export async function loadRouteScoreServices({ rootDir = process.cwd(), includeSeed = true, filePath } = {}) {
  const custom = await loadCustomServices({ rootDir, filePath });
  return includeSeed ? mergeServices(seedX402Services, custom) : custom;
}

export async function importServicesFile(filePath, { rootDir = process.cwd(), source = 'custom' } = {}) {
  const absolute = path.resolve(rootDir, filePath);
  const raw = await fs.readFile(absolute, 'utf8');
  let parsed;
  if (/\.ya?ml$/i.test(absolute)) parsed = parseSimpleYaml(raw);
  else parsed = JSON.parse(raw);
  const services = Array.isArray(parsed) ? parsed : parsed.services || [];
  return normalizeServiceList(services, { source });
}

export function mergeServices(...groups) {
  const byKey = new Map();
  for (const group of groups.flat()) {
    const service = normalizeService(group);
    const key = service.id || service.endpoint || service.domain;
    if (!key) continue;
    byKey.set(key, { ...(byKey.get(key) || {}), ...service });
  }
  return [...byKey.values()].sort((a, b) => serviceSortKey(a).localeCompare(serviceSortKey(b)));
}

export function serviceForDomain(domain, services = seedX402Services) {
  const normalized = normalizeDomain(domain);
  return services.find((service) => domainMatches(normalized, service.domain));
}

export function scoreService(service, telemetry = {}) {
  const normalizedService = normalizeService(service);
  const data = { ...DEFAULT_TELEMETRY, ...telemetry };
  let score = 55;
  const reasons = [];

  if (normalizedService.status === 'seed') {
    score += 10;
    reasons.push('seed service with documented category metadata');
  } else if (normalizedService.status === 'bazaar') {
    score += 6;
    reasons.push('live Bazaar catalog service');
  } else if (normalizedService.status === 'custom') {
    score += 3;
    reasons.push('local custom catalog service');
  } else if (normalizedService.status === 'watchlist') {
    score -= 8;
    reasons.push('watchlist service; verify payable endpoint before production routing');
  }

  if (normalizedService.hasPaymentMetadata) {
    score += 4;
    reasons.push('payment metadata present');
  }
  if (normalizedService.hasSchema) {
    score += 4;
    reasons.push('input/output schema metadata present');
  }

  if (Number.isFinite(data.successRate)) {
    score += Math.round((data.successRate - 0.8) * 65);
    reasons.push(`success rate ${(data.successRate * 100).toFixed(1)}%`);
  }
  if (Number.isFinite(data.schemaSuccessRate)) {
    score += Math.round((data.schemaSuccessRate - 0.85) * 35);
    reasons.push(`schema match ${(data.schemaSuccessRate * 100).toFixed(1)}%`);
  }
  if (Number.isFinite(data.medianLatencyMs)) {
    if (data.medianLatencyMs <= 1000) score += 8;
    else if (data.medianLatencyMs <= 2500) score += 2;
    else score -= 8;
    reasons.push(`median latency ${Math.round(data.medianLatencyMs)}ms`);
  }
  if (Number.isFinite(data.quoteLatencyMs)) {
    if (data.quoteLatencyMs <= 400) score += 4;
    else if (data.quoteLatencyMs > 1500) score -= 6;
    reasons.push(`quote latency ${Math.round(data.quoteLatencyMs)}ms`);
  }
  if (data.priceMatchedQuote === false) {
    score -= 25;
    reasons.push('price mismatch observed');
  }
  if (Number(data.recentFailureCount) > 0) {
    score -= Math.min(30, Number(data.recentFailureCount) * 7);
    reasons.push(`${data.recentFailureCount} recent failures`);
  }
  if (Number(data.samples) === 0) {
    score -= 6;
    reasons.push('no passive routed-call samples yet');
  } else {
    score += Math.min(12, Math.floor(Number(data.samples) / 10));
    reasons.push(`${data.samples} passive samples`);
  }

  const bounded = Math.max(0, Math.min(100, score));
  return {
    ...normalizedService,
    score: bounded,
    risk: scoreToRisk(bounded),
    reasons,
    telemetry: data,
    recommendation: recommendationForScore(bounded)
  };
}

export function recommendService({ category, maxPriceUSDC, services = seedX402Services, telemetry = {}, query } = {}) {
  const maxPrice = maxPriceUSDC === undefined || maxPriceUSDC === null || maxPriceUSDC === '' ? Infinity : Number(maxPriceUSDC);
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const candidates = services
    .map((service) => normalizeService(service))
    .filter((service) => !category || service.category === category)
    .filter((service) => !Number.isFinite(maxPrice) || service.priceUSDC <= maxPrice)
    .filter((service) => !terms.length || terms.every((term) => serviceSearchText(service).includes(term)))
    .map((service) => scoreService(service, telemetry[service.id] || {}))
    .sort((a, b) => b.score - a.score || a.priceUSDC - b.priceUSDC || serviceSortKey(a).localeCompare(serviceSortKey(b)));

  return {
    ok: candidates.length > 0,
    category: category || 'any',
    query: query || null,
    maxPriceUSDC: Number.isFinite(maxPrice) ? maxPrice : null,
    best: candidates[0] || null,
    alternatives: candidates.slice(1, 5),
    checkedAt: new Date().toISOString(),
    note: candidates.length ? 'Use RouteScore as a pre-spend signal, not a guarantee of output quality.' : 'No service matched the requested category/price/query.'
  };
}

export function routeService({ category, maxPriceUSDC, services = seedX402Services, telemetry = {}, query, minScore = 0 } = {}) {
  const rec = recommendService({ category, maxPriceUSDC, services, telemetry, query });
  const candidates = [rec.best, ...rec.alternatives].filter(Boolean).filter((service) => service.score >= Number(minScore || 0));
  const selected = candidates[0] || null;
  return {
    ok: Boolean(selected),
    selected,
    fallbacks: candidates.slice(1, 4),
    category: rec.category,
    query: rec.query,
    maxPriceUSDC: rec.maxPriceUSDC,
    checkedAt: rec.checkedAt,
    mode: 'recommend_and_fallback_plan',
    note: selected
      ? 'RouteScore selected a service and fallback plan. Sentinel still enforces payment policy before spend.'
      : 'No service met the requested route constraints.'
  };
}


export async function executeFallbackRoute({ plan, category, maxPriceUSDC, services = seedX402Services, telemetry = {}, query, minScore = 0, executor, onAttempt } = {}) {
  const routePlan = plan || routeService({ category, maxPriceUSDC, services, telemetry, query, minScore });
  if (!routePlan.selected) return { ok: false, plan: routePlan, attempts: [], error: 'no_route_available' };
  if (typeof executor !== 'function') throw new Error('executeFallbackRoute requires an executor(service, attempt) function.');

  const order = [routePlan.selected, ...(routePlan.fallbacks || [])];
  const attempts = [];
  for (let index = 0; index < order.length; index++) {
    const service = order[index];
    const started = Date.now();
    try {
      const result = await executor(service, { index, primary: index === 0, plan: routePlan });
      const latencyMs = Date.now() - started;
      const ok = result?.ok !== false;
      const attempt = { service, index, primary: index === 0, ok, latencyMs, error: result?.error || null, result: result?.result ?? result };
      attempts.push(attempt);
      if (onAttempt) await onAttempt(attempt);
      if (ok) return { ok: true, selected: service, result: attempt.result, attempts, plan: routePlan, fallbackUsed: index > 0 };
    } catch (error) {
      const attempt = { service, index, primary: index === 0, ok: false, latencyMs: Date.now() - started, error: error.message };
      attempts.push(attempt);
      if (onAttempt) await onAttempt(attempt);
    }
  }
  return { ok: false, selected: null, attempts, plan: routePlan, error: 'all_routes_failed' };
}

export function passiveTelemetryEvent({ serviceId, domain, ok, latencyMs, schemaOk = true, priceMatchedQuote = true, amountUSDC, errorType, category, endpoint, source, decision, mode, upstream, tool } = {}) {
  return {
    serviceId,
    domain: normalizeDomain(domain || endpoint),
    endpoint: endpoint || null,
    category: category || null,
    source: source || null,
    mode: mode || null,
    upstream: upstream || null,
    tool: tool || null,
    decision: decision || null,
    ok: ok === null || ok === undefined ? null : Boolean(ok),
    latencyMs: Number(latencyMs || 0),
    schemaOk: schemaOk === null || schemaOk === undefined ? null : Boolean(schemaOk),
    priceMatchedQuote: priceMatchedQuote === null || priceMatchedQuote === undefined ? null : Boolean(priceMatchedQuote),
    amountUSDC: Number(amountUSDC || 0),
    errorType: errorType || null,
    observedAt: new Date().toISOString(),
    privacy: 'anonymous endpoint telemetry only; no prompts, responses, secrets, or wallet balances'
  };
}

export async function fetchBazaarResources({ limit = 100, offset = 0, type = 'http', baseUrl = CDP_BAZAAR_RESOURCES_URL, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available in this Node runtime. Use Node.js 20+ or pass fetchImpl.');
  const url = new URL(baseUrl);
  if (type) url.searchParams.set('type', type);
  if (limit) url.searchParams.set('limit', String(limit));
  if (offset) url.searchParams.set('offset', String(offset));
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Bazaar resources request failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  const services = normalizeBazaarPayload(json, { source: 'bazaar' });
  return { ok: true, url: url.toString(), services, rawCount: Array.isArray(json.items) ? json.items.length : services.length, pagination: json.pagination || null, fetchedAt: new Date().toISOString() };
}

export async function fetchBazaarSearch({ query = '', limit = 20, network, asset, baseUrl = CDP_BAZAAR_SEARCH_URL, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available in this Node runtime. Use Node.js 20+ or pass fetchImpl.');
  const url = new URL(baseUrl);
  if (query) url.searchParams.set('query', query);
  if (limit) url.searchParams.set('limit', String(limit));
  if (network) url.searchParams.set('network', network);
  if (asset) url.searchParams.set('asset', asset);
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Bazaar search request failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  const services = normalizeBazaarPayload(json, { source: 'bazaar' });
  return { ok: true, url: url.toString(), services, searchMethod: json.searchMethod || null, partialResults: Boolean(json.partialResults), fetchedAt: new Date().toISOString() };
}

export function normalizeBazaarPayload(payload = {}, { source = 'bazaar' } = {}) {
  const items = payload.items || payload.resources || payload.results || [];
  return normalizeServiceList(items, { source });
}

export function normalizeServiceList(services = [], { source = 'custom' } = {}) {
  return services.map((service, index) => normalizeService(service, { source, index })).filter((service) => service.endpoint && service.domain);
}

export function normalizeService(service = {}, { source, index = 0 } = {}) {
  const inferredSource = source || service.source || (service.resource ? 'bazaar' : 'custom');
  const endpoint = service.endpoint || service.resource || service.url || service.uri || '';
  const domain = normalizeDomain(service.domain || endpoint);
  const metadata = service.metadata || service.meta || {};
  const accepts = Array.isArray(service.accepts) ? service.accepts : [];
  const name = service.name || metadata.name || metadata.title || readableName(domain, endpoint, index);
  const category = normalizeCategory(service.category || metadata.category || inferCategory(`${name} ${endpoint} ${metadata.description || ''} ${(metadata.tags || []).join?.(' ') || ''}`));
  const priceUSDC = Number.isFinite(Number(service.priceUSDC)) ? Number(service.priceUSDC) : inferPriceUSDC(accepts);
  const tags = Array.isArray(service.tags) ? service.tags : Array.isArray(metadata.tags) ? metadata.tags : categoryTags(category);
  const id = slugify(service.id || `${inferredSource}-${domain}-${URL_SAFE_PATH(endpoint)}`) || `service-${index}`;
  return {
    id,
    name,
    category,
    domain,
    endpoint,
    network: normalizeNetwork(service.network || accepts[0]?.network || 'base'),
    priceUSDC,
    status: service.status || (inferredSource === 'bazaar' ? 'bazaar' : inferredSource === 'seed' ? service.status || 'seed' : 'custom'),
    source: inferredSource,
    tags,
    note: service.note || metadata.description || `${category} service from ${inferredSource} catalog.`,
    accepts,
    hasPaymentMetadata: Boolean(accepts.length),
    hasSchema: Boolean(metadata.input || metadata.output || metadata.inputSchema || metadata.outputSchema || service.inputSchema || service.outputSchema),
    lastUpdated: service.lastUpdated || service.updatedAt || service.fetchedAt || null
  };
}

export function parseSimpleYaml(raw) {
  const lines = raw.split(/\r?\n/);
  const services = [];
  let current = null;
  let inServices = false;
  let pendingArrayKey = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const trimmed = line.trim();
    if (trimmed === 'services:') { inServices = true; continue; }
    if (!inServices && !trimmed.startsWith('- ')) continue;

    if (trimmed.startsWith('- ')) {
      const rest = trimmed.slice(2).trim();
      if (rest.includes(':')) {
        if (current) services.push(current);
        current = {};
        pendingArrayKey = null;
        const [key, ...valueParts] = rest.split(':');
        const value = valueParts.join(':').trim();
        current[key.trim()] = parseYamlValue(value);
      } else if (pendingArrayKey && current) {
        current[pendingArrayKey].push(parseYamlValue(rest));
      }
      continue;
    }

    if (!current || !trimmed.includes(':')) continue;
    const [key, ...valueParts] = trimmed.split(':');
    const cleanKey = key.trim();
    const value = valueParts.join(':').trim();
    if (value === '') {
      current[cleanKey] = [];
      pendingArrayKey = cleanKey;
    } else {
      current[cleanKey] = parseYamlValue(value);
      pendingArrayKey = null;
    }
  }
  if (current) services.push(current);
  return { services };
}

function parseYamlValue(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1).split(',').map((item) => parseYamlValue(item)).filter(Boolean);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function scoreToRisk(score) {
  if (score >= 85) return 'low';
  if (score >= 70) return 'medium';
  if (score >= 50) return 'elevated';
  return 'high';
}

function recommendationForScore(score) {
  if (score >= 85) return 'prefer';
  if (score >= 70) return 'use_with_limits';
  if (score >= 50) return 'trial_only';
  return 'avoid_or_approval';
}

function serviceSortKey(service) {
  return `${service.category || ''}:${service.name || ''}:${service.endpoint || ''}`.toLowerCase();
}

function serviceSearchText(service) {
  return [service.name, service.category, service.domain, service.endpoint, service.note, ...(service.tags || [])].join(' ').toLowerCase();
}

function slugify(value) {
  return String(value || '').toLowerCase().replace(/https?:\/\//g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function readableName(domain, endpoint, index) {
  if (!domain) return `Imported Service ${index + 1}`;
  const pathPart = endpointPath(endpoint).split('/').filter(Boolean).slice(-1)[0];
  return `${domain}${pathPart ? ` ${pathPart}` : ''}`;
}

function endpointPath(endpoint) {
  try { return new URL(endpoint).pathname || ''; } catch { return ''; }
}

function URL_SAFE_PATH(endpoint) {
  return endpointPath(endpoint).replace(/\//g, '-');
}

function normalizeCategory(category) {
  const value = String(category || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!value) return 'general';
  if (SERVICE_CATEGORIES[value]) return value;
  for (const [id, meta] of Object.entries(SERVICE_CATEGORIES)) {
    if ((meta.aliases || []).includes(value)) return id;
  }
  return value;
}

function inferCategory(text) {
  const value = String(text || '').toLowerCase();
  if (/search|research|serp|query|answer engine/.test(value)) return 'web_search';
  if (/content|extract|readability|article|url text|document parse|pdf/.test(value)) return 'content_extraction';
  if (/browser|session|navigate|headless|page/.test(value)) return 'browser';
  if (/scrap|crawl|spider|site map/.test(value)) return 'scraping';
  if (/price|market|quote|ticker|ohlc|chart|news|token price/.test(value)) return 'market_data';
  if (/wallet|address|holder|risk|intel|portfolio|transaction history/.test(value)) return 'wallet_intel';
  if (/rpc|chain|contract|token|web3|base|nft|block/.test(value)) return 'web3_data';
  if (/image|vision|generate|thumbnail|creative|logo/.test(value)) return 'image_generation';
  if (/model|llm|inference|chat|completion|prompt|embedding/.test(value)) return 'inference';
  if (/code|sandbox|execute|python|javascript|runtime/.test(value)) return 'code_execution';
  if (/storage|file|blob|ipfs|pinning/.test(value)) return 'storage';
  if (/identity|auth|attestation|profile|did/.test(value)) return 'identity';
  if (/email|sms|message|notify|notification|telegram|discord/.test(value)) return 'messaging';
  if (/payment|settle|checkout|invoice|wallet/.test(value)) return 'payments';
  return 'general';
}

function categoryTags(category) {
  return String(category || 'general').split('_').filter(Boolean);
}

function normalizeNetwork(network) {
  const value = String(network || '').toLowerCase();
  if (value === 'eip155:8453') return 'base';
  if (value === 'eip155:84532') return 'base-sepolia';
  return network || 'base';
}

function inferPriceUSDC(accepts = []) {
  const exact = accepts.find((item) => item && item.amount !== undefined);
  if (!exact) return 0.01;
  const amount = Number(exact.amount);
  if (!Number.isFinite(amount)) return 0.01;
  if (amount >= 1000) return Number((amount / 1_000_000).toFixed(6));
  return amount;
}
