import fs from 'node:fs/promises';
import { exists } from './fs.js';
import { matchesAnyGlob, normalizePath } from './path-utils.js';

export const SEVERITY_ORDER = ['info', 'low', 'medium', 'high', 'critical'];

export const defaultPolicy = Object.freeze({
  version: '0.10',
  mode: 'enforce',
  project: 'mythos-sentinel-project',
  filesystem: {
    deny: ['.env', '.env.*', '**/.env', '**/.env.*', '**/id_rsa', '**/id_ed25519', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx'],
    allowRead: ['**/*'],
    allowWrite: ['src/**', 'test/**', 'docs/**', 'examples/**', '.github/workflows/**', 'README.md', 'package.json', 'package-lock.json', 'mythos.policy.json']
  },
  commands: {
    blockedPatterns: [
      'curl\\s+[^|]+\\|\\s*(sudo\\s+)?(bash|sh|zsh)',
      'wget\\s+[^|]+\\|\\s*(sudo\\s+)?(bash|sh|zsh)',
      'Invoke-WebRequest[^|]+\\|\\s*iex',
      'iwr\\s+[^|]+\\s*\\|\\s*iex',
      'rm\\s+-rf\\s+(/|~|\\$HOME|\\.\\./)',
      'chmod\\s+777',
      'base64\\s+-d\\s+[^|]+\\|\\s*(bash|sh|zsh)',
      'powershell\\s+.*-enc(odedcommand)?'
    ],
    approvalPatterns: [
      'npm\\s+install',
      'pnpm\\s+install',
      'yarn\\s+add',
      'pip\\s+install',
      'docker\\s+run',
      'git\\s+push'
    ]
  },
  network: {
    blockUnknown: false,
    allowedDomains: ['api.github.com', 'api.openai.com', 'api.anthropic.com', 'api.coinbase.com', 'api.developer.coinbase.com', 'api.exa.ai'],
    deniedDomains: []
  },
  payments: {
    x402: {
      enabled: true,
      strategy: 'balanced',
      enforceAllowlist: false,
      maxPerRequestUSDC: 0.25,
      maxDailyUSDC: 5,
      requireApprovalAboveUSDC: 0.25,
      trustedDomains: ['api.coinbase.com', 'api.developer.coinbase.com', 'api.exa.ai', 'www.x402.org', 'x402.org'],
      allowedDomains: [],
      deniedDomains: [],
      unknown: {
        allowTrial: true,
        maxPerRequestUSDC: 0.02,
        maxDailyUSDC: 0.25,
        requireApprovalAboveUSDC: 0.02
      },
      routeScore: {
        autoAllowMinScore: 80,
        requireApprovalBelowScore: 60,
        blockBelowScore: 35
      }
    }
  },
  routeScore: {
    enabled: true,
    catalogMode: 'seed',
    telemetry: {
      enabled: false,
      anonymous: true,
      localOnly: true,
      storePath: '.mythos/telemetry/events.jsonl',
      collectPrompts: false,
      collectResponses: false,
      collectWalletBalances: false
    },
    seedCategories: ['web_search', 'content_extraction', 'inference', 'web3_data', 'wallet_intel']
  },
  mcpProxy: {
    enabled: true,
    mode: 'enforce',
    approvalMode: 'return_error',
    toolNameStrategy: 'preserve_unless_collision',
    exposeSentinelTools: false,
    upstreams: []
  },
  findings: {
    failOn: ['critical', 'high'],
    warnOn: ['medium']
  },
  scanner: {
    ignore: ['mythos.policy.json'],
    useMythosIgnore: true
  },
  receipts: {
    require: true,
    includeFileHashes: true
  }
});

export async function loadPolicy(policyPath = 'mythos.policy.json') {
  if (!(await exists(policyPath))) return structuredClone(defaultPolicy);
  const raw = await fs.readFile(policyPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Policy must be JSON for v0.2. Could not parse ${policyPath}: ${error.message}`);
  }
  return mergePolicy(defaultPolicy, parsed);
}

export function mergePolicy(base, overrides) {
  if (Array.isArray(base) || Array.isArray(overrides)) return overrides ?? base;
  if (isObject(base) && isObject(overrides)) {
    const result = { ...base };
    for (const [key, value] of Object.entries(overrides)) result[key] = mergePolicy(base[key], value);
    return result;
  }
  return overrides ?? base;
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function severityAtLeast(actual, threshold) {
  return SEVERITY_ORDER.indexOf(actual) >= SEVERITY_ORDER.indexOf(threshold);
}

export function highestSeverity(findings = []) {
  return findings.reduce((highest, finding) => {
    return SEVERITY_ORDER.indexOf(finding.severity) > SEVERITY_ORDER.indexOf(highest) ? finding.severity : highest;
  }, 'info');
}

export function evaluateFindings(findings, policy, failOnOverride) {
  const failOn = failOnOverride && failOnOverride !== 'none' ? [failOnOverride] : policy.findings?.failOn || [];
  const failing = failOnOverride === 'none' ? [] : findings.filter((finding) =>
    failOn.some((severity) => severityAtLeast(finding.severity, severity))
  );
  return {
    ok: failing.length === 0,
    highestSeverity: highestSeverity(findings),
    findingCount: findings.length,
    failingCount: failing.length,
    failing
  };
}

export function normalizeDomain(input) {
  if (!input) return '';
  try {
    const withProtocol = /^[a-z]+:\/\//i.test(input) ? input : `https://${input}`;
    return new URL(withProtocol).hostname.toLowerCase();
  } catch {
    return String(input).toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  }
}

export function domainMatches(domain, pattern) {
  const normalized = normalizeDomain(domain);
  const normalizedPattern = normalizeDomain(pattern);
  return normalized === normalizedPattern || normalized.endsWith(`.${normalizedPattern}`);
}

export function checkNetwork({ domain }, policy) {
  const normalizedDomain = normalizeDomain(domain);
  const network = policy.network || {};
  const reasons = [];

  if (!normalizedDomain) reasons.push('missing network domain');
  if ((network.deniedDomains || []).some((pattern) => domainMatches(normalizedDomain, pattern))) reasons.push(`domain denied: ${normalizedDomain}`);
  if (network.blockUnknown && (network.allowedDomains || []).length && !(network.allowedDomains || []).some((pattern) => domainMatches(normalizedDomain, pattern))) {
    reasons.push(`domain not in network allowlist: ${normalizedDomain}`);
  }

  return reasons.length ? { ok: false, decision: 'block', subject: normalizedDomain, reasons } : { ok: true, decision: 'allow', subject: normalizedDomain, reasons: ['network access within policy'] };
}

export function checkCommand({ command }, policy) {
  const value = String(command || '').trim();
  const reasons = [];
  const approvals = [];
  if (!value) reasons.push('missing command');

  for (const pattern of policy.commands?.blockedPatterns || []) {
    const regex = safeRegex(pattern);
    if (regex?.test(value)) reasons.push(`blocked command pattern matched: ${pattern}`);
  }
  for (const pattern of policy.commands?.approvalPatterns || []) {
    const regex = safeRegex(pattern);
    if (regex?.test(value)) approvals.push(`approval pattern matched: ${pattern}`);
  }

  if (reasons.length) return { ok: false, decision: 'block', subject: redactCommand(value), reasons };
  if (approvals.length) return { ok: false, decision: 'approval_required', subject: redactCommand(value), reasons: approvals };
  return { ok: true, decision: 'allow', subject: redactCommand(value), reasons: ['command within policy'] };
}

export function checkFilesystemAccess({ filePath, operation = 'read' }, policy) {
  const rel = normalizePath(String(filePath || '').replace(/^\.\//, ''));
  const fsPolicy = policy.filesystem || {};
  const reasons = [];
  const op = String(operation || 'read').toLowerCase();

  if (!rel) reasons.push('missing file path');
  if (matchesAnyGlob(rel, fsPolicy.deny || [])) reasons.push(`path denied by filesystem policy: ${rel}`);
  if (op === 'write' && (fsPolicy.allowWrite || []).length && !matchesAnyGlob(rel, fsPolicy.allowWrite || [])) {
    reasons.push(`write path not in allowWrite list: ${rel}`);
  }
  if (op === 'read' && (fsPolicy.allowRead || []).length && !matchesAnyGlob(rel, fsPolicy.allowRead || [])) {
    reasons.push(`read path not in allowRead list: ${rel}`);
  }

  return reasons.length ? { ok: false, decision: 'block', subject: rel, operation: op, reasons } : { ok: true, decision: 'allow', subject: rel, operation: op, reasons: ['filesystem access within policy'] };
}

export function checkPayment({
  domain,
  amountUSDC,
  dailySpentUSDC = 0,
  unknownDailySpentUSDC = 0,
  routeScore,
  category,
  knownService = false
}, policy) {
  const x402 = policy.payments?.x402 || {};
  if (!x402.enabled) return { ok: true, decision: 'allow', reasons: ['x402 guard disabled'] };

  const normalizedDomain = normalizeDomain(domain);
  const amount = Number(amountUSDC);
  const daily = Number(dailySpentUSDC || 0);
  const unknownDaily = Number(unknownDailySpentUSDC || 0);
  const routeScoreValue = routeScore === undefined || routeScore === null || routeScore === '' ? null : Number(routeScore);
  const strategy = x402.strategy || (x402.enforceAllowlist ? 'strict' : 'balanced');
  const trustedDomains = [...(x402.trustedDomains || []), ...(x402.allowedDomains || [])];
  const isTrustedDomain = trustedDomains.some((pattern) => domainMatches(normalizedDomain, pattern));
  const blockReasons = [];
  const approvalReasons = [];
  const reasons = [];

  if (!normalizedDomain) blockReasons.push('missing payment domain');
  if (!Number.isFinite(amount) || amount < 0) blockReasons.push('invalid payment amount');
  if ((x402.deniedDomains || []).some((pattern) => domainMatches(normalizedDomain, pattern))) blockReasons.push(`domain denied: ${normalizedDomain}`);

  if (x402.enforceAllowlist || strategy === 'strict') {
    if (trustedDomains.length && !isTrustedDomain) approvalReasons.push(`domain not trusted for automatic x402 spend: ${normalizedDomain}`);
  }

  if (Number.isFinite(x402.maxPerRequestUSDC) && amount > x402.maxPerRequestUSDC) {
    blockReasons.push(`amount ${amount} USDC exceeds maxPerRequestUSDC ${x402.maxPerRequestUSDC}`);
  }
  if (Number.isFinite(x402.maxDailyUSDC) && daily + amount > x402.maxDailyUSDC) {
    blockReasons.push(`daily spend ${daily + amount} USDC exceeds maxDailyUSDC ${x402.maxDailyUSDC}`);
  }

  const routePolicy = x402.routeScore || {};
  if (Number.isFinite(routeScoreValue)) {
    reasons.push(`RouteScore signal: ${routeScoreValue}/100`);
    if (Number.isFinite(routePolicy.blockBelowScore) && routeScoreValue < routePolicy.blockBelowScore) {
      blockReasons.push(`RouteScore ${routeScoreValue} is below blockBelowScore ${routePolicy.blockBelowScore}`);
    } else if (Number.isFinite(routePolicy.requireApprovalBelowScore) && routeScoreValue < routePolicy.requireApprovalBelowScore) {
      approvalReasons.push(`RouteScore ${routeScoreValue} is below approval threshold ${routePolicy.requireApprovalBelowScore}`);
    }
  }

  const isRouteScoreTrusted = Number.isFinite(routeScoreValue) && routeScoreValue >= Number(routePolicy.autoAllowMinScore ?? 80);
  const trustTier = isTrustedDomain ? 'trusted' : (knownService || isRouteScoreTrusted ? 'known' : 'unknown');

  if (trustTier === 'trusted') {
    reasons.push(`trusted payment domain: ${normalizedDomain}`);
  } else if (trustTier === 'known') {
    reasons.push(`known service${Number.isFinite(routeScoreValue) ? ` with RouteScore ${routeScoreValue}` : ''}`);
  } else {
    const unknown = x402.unknown || {};
    reasons.push(`unknown x402 domain: ${normalizedDomain}`);
    if (strategy === 'strict') {
      approvalReasons.push('strict strategy requires approval for unknown payment domains');
    } else if (unknown.allowTrial === false) {
      approvalReasons.push('unknown-domain trial payments are disabled');
    } else {
      if (Number.isFinite(unknown.maxPerRequestUSDC) && amount > unknown.maxPerRequestUSDC) {
        approvalReasons.push(`unknown-domain amount ${amount} USDC exceeds trial max ${unknown.maxPerRequestUSDC}`);
      }
      if (Number.isFinite(unknown.maxDailyUSDC) && unknownDaily + amount > unknown.maxDailyUSDC) {
        approvalReasons.push(`unknown-domain daily spend ${unknownDaily + amount} USDC exceeds trial daily max ${unknown.maxDailyUSDC}`);
      }
      if (Number.isFinite(unknown.requireApprovalAboveUSDC) && amount > unknown.requireApprovalAboveUSDC) {
        approvalReasons.push(`unknown-domain amount ${amount} USDC requires approval above ${unknown.requireApprovalAboveUSDC}`);
      }
      if (!approvalReasons.length) reasons.push('tiny unknown-domain trial spend allowed by adaptive policy');
    }
  }

  if (Number.isFinite(x402.requireApprovalAboveUSDC) && amount > x402.requireApprovalAboveUSDC) {
    approvalReasons.push(`amount ${amount} USDC requires human approval above ${x402.requireApprovalAboveUSDC}`);
  }

  const base = {
    subject: normalizedDomain,
    category: category || null,
    amountUSDC: amount,
    dailySpentUSDC: daily,
    trustTier,
    routeScore: Number.isFinite(routeScoreValue) ? routeScoreValue : null,
    strategy,
    reasons: [...reasons, ...blockReasons, ...approvalReasons]
  };

  if (blockReasons.length) return { ...base, ok: false, decision: 'block' };
  if (approvalReasons.length) return { ...base, ok: false, decision: 'approval_required' };
  return { ...base, ok: true, decision: 'allow' };
}

function safeRegex(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

function redactCommand(command) {
  return command.replace(/(PRIVATE_KEY|MNEMONIC|SEED_PHRASE|API_KEY|TOKEN|SECRET)(\s*[:=]\s*)['\"]?[^\s'\"]+/ig, '$1$2[REDACTED]');
}
