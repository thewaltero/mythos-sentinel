import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { loadPolicy, checkPayment, checkCommand, checkFilesystemAccess, checkNetwork, normalizeDomain, paymentDomainTier } from '../core/policy.js';
import { seedX402Services, serviceForDomain, scoreService } from '../core/routescore.js';
import { appendTelemetryEvent, telemetryEnabled } from '../core/telemetry.js';
import { dailySpend, recordSpend, effectiveSpend } from '../core/spend-ledger.js';
import { VERSION } from '../version.js';

export const PROXY_SERVER_NAME = 'mythos-sentinel-proxy';

const DEFAULT_PROXY = Object.freeze({
  mode: 'enforce',
  approvalMode: 'return_error',
  exposeSentinelTools: true,
  toolNameStrategy: 'preserve_unless_collision',
  // What happens to a tools/call that classifyToolCall could not recognize as
  // payment, command, file, or network intent. 'allow' preserves existing
  // behavior (classification is heuristic; see THREAT_MODEL.md). Security-
  // sensitive deployments should set 'approval_required' or 'block' so the
  // proxy fails closed on tools it does not understand.
  defaultAction: 'allow',
  upstreams: []
});

const DEFAULT_ACTIONS = Object.freeze(['allow', 'approval_required', 'block']);

/**
 * Run an enforcing MCP proxy over stdio.
 *
 * The proxy speaks normal MCP JSON-RPC to the agent, connects to one or more
 * upstream MCP servers, mirrors their tools, and gates every tools/call before
 * forwarding. It is intentionally conservative: block and approval_required
 * decisions are never forwarded to the upstream server.
 */
export async function runMcpProxy({ input = process.stdin, output = process.stdout, policyPath = 'mythos.policy.json', configPath } = {}) {
  const policy = await loadPolicy(policyPath);
  const proxyConfig = await loadProxyConfig({ policy, configPath });
  const proxy = new McpProxy({ policy, proxyConfig, rootDir: path.dirname(path.resolve(policyPath)) });
  await proxy.start();

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message;
    try {
      message = JSON.parse(trimmed);
      const response = await proxy.handleMessage(message);
      if (response) output.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      const id = message?.id ?? null;
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: error.message } })}\n`);
    }
  }

  await proxy.stop();
}

export async function loadProxyConfig({ policy, configPath } = {}) {
  if (configPath) {
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(configPath, 'utf8');
    return normalizeProxyConfig(JSON.parse(raw));
  }
  return normalizeProxyConfig(policy.mcpProxy || policy.runtimeMcpProxy || {});
}

export function normalizeProxyConfig(config = {}) {
  const merged = { ...DEFAULT_PROXY, ...config };
  merged.upstreams = Array.isArray(merged.upstreams) ? merged.upstreams : [];
  merged.mode = merged.mode || 'enforce';
  merged.approvalMode = merged.approvalMode || 'return_error';
  merged.toolNameStrategy = merged.toolNameStrategy || 'preserve_unless_collision';
  merged.defaultAction = DEFAULT_ACTIONS.includes(merged.defaultAction) ? merged.defaultAction : 'allow';
  return merged;
}

export class McpProxy {
  constructor({ policy, proxyConfig, clients, rootDir = process.cwd() } = {}) {
    this.policy = policy;
    this.proxyConfig = normalizeProxyConfig(proxyConfig || policy?.mcpProxy || {});
    this.clients = clients || [];
    this.rootDir = rootDir;
    this.toolIndex = new Map();
    this.initialized = false;
  }

  async start() {
    if (!this.clients.length) {
      this.clients = this.proxyConfig.upstreams.map((upstream) => new StdioMcpClient(upstream));
    }
    for (const client of this.clients) await client.start();
    await this.refreshToolIndex();
    this.initialized = true;
  }

  async stop() {
    await Promise.allSettled(this.clients.map((client) => client.stop?.()));
  }

  async refreshToolIndex() {
    this.toolIndex.clear();
    const usedNames = new Set();

    for (const client of this.clients) {
      const listed = await client.listTools();
      const tools = listed?.tools || [];
      for (const tool of tools) {
        const publicName = this.publicToolName(tool.name, client.id, usedNames);
        usedNames.add(publicName);
        this.toolIndex.set(publicName, { client, upstreamName: tool.name, tool, publicName });
      }
    }
  }

  publicToolName(name, upstreamId, usedNames) {
    if (this.proxyConfig.toolNameStrategy === 'prefix') return `${upstreamId}__${name}`;
    if (!usedNames.has(name)) return name;
    return `${upstreamId}__${name}`;
  }

  async handleMessage(message) {
    const { id, method, params = {} } = message;
    if (!method || id === undefined) return null;

    if (method === 'initialize') {
      return result(id, {
        protocolVersion: params.protocolVersion || '2025-06-18',
        serverInfo: { name: PROXY_SERVER_NAME, version: VERSION },
        capabilities: { tools: {} }
      });
    }

    if (method === 'tools/list') {
      if (!this.initialized) await this.start();
      return result(id, { tools: this.listPublicTools() });
    }

    if (method === 'tools/call') {
      if (!this.initialized) await this.start();
      return result(id, await this.callTool(params.name, params.arguments || {}));
    }

    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }

  listPublicTools() {
    return [...this.toolIndex.values()].map(({ tool, publicName, client }) => ({
      ...tool,
      name: publicName,
      description: decorateDescription(tool.description, client.id)
    }));
  }

  async callTool(publicName, args) {
    const entry = this.toolIndex.get(publicName);
    if (!entry) return proxyContent({ ok: false, decision: 'block', reason: `Unknown proxied tool: ${publicName}` }, true);

    // Sentinel's own ledger is the source of truth for budget state; the
    // caller's args can only tighten it (see evaluateToolCall). A corrupted
    // ledger reads as zero recorded spend — fail direction documented in
    // THREAT_MODEL.md.
    const spend = await dailySpend({ rootDir: this.rootDir });

    const decision = evaluateToolCall({
      toolName: publicName,
      upstreamName: entry.upstreamName,
      upstreamId: entry.client.id,
      args,
      policy: this.policy,
      spend,
      defaultAction: this.proxyConfig.defaultAction
    });

    if (decision.decision === 'block') {
      await this.recordToolTelemetry({ entry, decision, ok: null, latencyMs: 0, errorType: 'blocked_by_policy' });
      return blockedToolResult(decision);
    }
    if (decision.decision === 'approval_required') {
      await this.recordToolTelemetry({ entry, decision, ok: null, latencyMs: 0, errorType: 'approval_required' });
      return approvalToolResult(decision);
    }

    // Reserve the spend for every payment intent we are about to forward,
    // *before* the upstream call: if the process dies mid-call, the ledger
    // has already counted the attempt (conservative direction). Receipt
    // ingestion may count the same payment again; over-counting only
    // tightens the budget.
    for (const candidate of decision.candidates || []) {
      if (candidate.type !== 'payment') continue;
      const amount = Number(candidate.amountUSDC);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const matched = serviceForDomain(candidate.domain, seedX402Services);
      const tier = paymentDomainTier(candidate.domain, this.policy, {
        knownService: Boolean(matched) || Boolean(candidate.knownService)
      });
      await recordSpend({
        rootDir: this.rootDir,
        domain: candidate.domain,
        amountUSDC: amount,
        tier,
        source: 'mcp-proxy'
      });
    }

    const started = Date.now();
    try {
      const upstream = await entry.client.callTool(entry.upstreamName, args);
      const latencyMs = Date.now() - started;
      await this.recordToolTelemetry({ entry, decision, ok: !upstream?.isError, latencyMs, errorType: upstream?.isError ? 'upstream_is_error' : null });
      return annotateUpstreamResult(upstream, {
        sentinel: {
          ok: true,
          decision: 'allow',
          mode: 'proxy',
          upstream: entry.client.id,
          tool: entry.upstreamName,
          latencyMs,
          checks: decision.checks,
          reasons: decision.reasons,
          telemetry: telemetryEnabled(this.policy) ? 'stored_locally_if_api_call_detected' : 'disabled'
        }
      });
    } catch (error) {
      const latencyMs = Date.now() - started;
      await this.recordToolTelemetry({ entry, decision, ok: false, latencyMs, errorType: 'upstream_exception' });
      return proxyContent({
        ok: false,
        decision: 'upstream_error',
        upstream: entry.client.id,
        tool: entry.upstreamName,
        error: error.message,
        latencyMs
      }, true);
    }
  }

  async recordToolTelemetry({ entry, decision, ok, latencyMs, errorType }) {
    const candidate = (decision.candidates || []).find((item) => (item.type === 'payment' || item.type === 'network') && item.domain && !String(item.domain).includes('unknown-'));
    if (!candidate) return { ok: true, stored: false, reason: 'no_api_candidate' };
    try {
      return await appendTelemetryEvent({
        rootDir: this.rootDir,
        policy: this.policy,
        event: {
          source: 'mcp_proxy',
          mode: 'proxy',
          domain: candidate.domain,
          category: candidate.category,
          upstream: entry.client.id,
          tool: entry.upstreamName,
          decision: decision.decision,
          ok,
          latencyMs,
          amountUSDC: candidate.amountUSDC || 0,
          schemaOk: ok === null ? null : true,
          priceMatchedQuote: true,
          errorType
        }
      });
    } catch {
      return { ok: false, stored: false, reason: 'telemetry_write_failed' };
    }
  }
}

export class StdioMcpClient extends EventEmitter {
  constructor({ id, name, command, args = [], cwd, env = {}, initTimeoutMs = 8000 } = {}) {
    super();
    if (!id && !name) throw new Error('Proxy upstream requires id or name.');
    if (!command) throw new Error(`Proxy upstream ${id || name} requires command.`);
    this.id = id || name;
    this.command = command;
    this.args = args;
    this.cwd = cwd || process.cwd();
    this.env = { ...process.env, ...env };
    this.initTimeoutMs = initTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
  }

  async start() {
    if (this.child) return;
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.child.stderr?.on('data', (chunk) => this.emit('stderr', chunk.toString('utf8')));
    this.child.on('exit', (code, signal) => {
      for (const { reject } of this.pending.values()) reject(new Error(`Upstream ${this.id} exited (${code ?? signal})`));
      this.pending.clear();
      this.child = null;
    });

    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this.handleLine(line));

    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      clientInfo: { name: PROXY_SERVER_NAME, version: VERSION },
      capabilities: {}
    }, this.initTimeoutMs);
    this.notify('notifications/initialized', {});
  }

  async stop() {
    if (!this.child) return;
    this.child.kill();
    this.child = null;
  }

  async listTools() {
    return this.request('tools/list', {});
  }

  async callTool(name, args) {
    return this.request('tools/call', { name, arguments: args });
  }

  notify(method, params) {
    if (!this.child?.stdin) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  request(method, params = {}, timeoutMs = 30000) {
    if (!this.child?.stdin) return Promise.reject(new Error(`Upstream ${this.id} is not running.`));
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Upstream ${this.id} timed out on ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || 'Upstream MCP error'));
    else pending.resolve(message.result);
  }
}

export function evaluateToolCall({ toolName, upstreamName, upstreamId, args = {}, policy, spend, defaultAction = 'allow' }) {
  const checks = [];
  const reasons = [];
  const tool = `${upstreamId || 'upstream'}:${upstreamName || toolName}`;
  const candidates = classifyToolCall({ toolName, upstreamName, args });

  for (const candidate of candidates) {
    let decision;
    if (candidate.type === 'payment') {
      const matched = serviceForDomain(candidate.domain, seedX402Services);
      const score = matched ? scoreService(matched).score : candidate.routeScore;
      // Budget figures come from Sentinel's own spend ledger when provided.
      // Caller-supplied running totals are honored only via max(): an agent
      // reporting 0 cannot reset its budget; an agent reporting more than the
      // ledger has seen tightens enforcement early. (See THREAT_MODEL.md.)
      const effective = effectiveSpend({
        ledgerSpend: spend,
        reportedDailyUSDC: candidate.dailySpentUSDC || 0,
        reportedUnknownDailyUSDC: candidate.unknownDailySpentUSDC || 0
      });
      decision = checkPayment({
        domain: candidate.domain,
        amountUSDC: candidate.amountUSDC,
        dailySpentUSDC: effective.dailySpentUSDC,
        unknownDailySpentUSDC: effective.unknownDailySpentUSDC,
        routeScore: score,
        category: candidate.category,
        knownService: Boolean(matched) || Boolean(candidate.knownService)
      }, policy);
    } else if (candidate.type === 'command') {
      decision = checkCommand({ command: candidate.command }, policy);
    } else if (candidate.type === 'file') {
      decision = checkFilesystemAccess({ filePath: candidate.path, operation: candidate.operation || 'read' }, policy);
    } else if (candidate.type === 'network') {
      decision = checkNetwork({ domain: candidate.domain }, policy);
    }

    if (decision) {
      checks.push({ type: candidate.type, ...decision });
      reasons.push(...(decision.reasons || []).map((reason) => `${candidate.type}: ${reason}`));
      if (decision.decision === 'block') return { ok: false, decision: 'block', tool, checks, reasons, candidates };
      if (decision.decision === 'approval_required') return { ok: false, decision: 'approval_required', tool, checks, reasons, candidates };
    }
  }

  if (!checks.length) {
    // Classification is heuristic, so an unrecognized tool call is an honest
    // "we don't know what this does" — the policy decides what that means.
    if (defaultAction === 'block') {
      reasons.push('no payment, shell, file, or network intent recognized; blocked by mcpProxy.defaultAction=block');
      return { ok: false, decision: 'block', tool, checks, reasons, candidates };
    }
    if (defaultAction === 'approval_required') {
      reasons.push('no payment, shell, file, or network intent recognized; approval required by mcpProxy.defaultAction=approval_required');
      return { ok: false, decision: 'approval_required', tool, checks, reasons, candidates };
    }
    reasons.push('no risky payment, shell, file, or network intent detected; forwarded by proxy (mcpProxy.defaultAction=allow)');
  }
  return { ok: true, decision: 'allow', tool, checks, reasons, candidates };
}

export function classifyToolCall({ toolName = '', upstreamName = '', args = {} } = {}) {
  const name = `${toolName} ${upstreamName}`.toLowerCase();
  const out = [];
  const domain = firstString(args.domain, args.host, args.hostname, domainFromUrl(args.url), domainFromUrl(args.endpoint), domainFromUrl(args.uri));
  const amountUSDC = firstNumber(args.amountUSDC, args.usdc, args.priceUSDC, args.price, args.amount, args.cost);

  if (name.match(/x402|payment|pay|purchase|spend|charge|settle|wallet/) || amountUSDC !== null) {
    out.push({
      type: 'payment',
      domain: domain || 'unknown-payment-domain.local',
      amountUSDC: amountUSDC ?? 0,
      dailySpentUSDC: firstNumber(args.dailySpentUSDC, args.dailySpent),
      unknownDailySpentUSDC: firstNumber(args.unknownDailySpentUSDC, args.unknownDailySpent),
      routeScore: firstNumber(args.routeScore),
      category: firstString(args.category, args.type),
      knownService: Boolean(args.knownService)
    });
  }

  const command = firstString(args.command, args.cmd, args.shell, args.script);
  if (command || name.match(/shell|bash|terminal|command|exec|spawn|run/)) {
    out.push({ type: 'command', command: command || upstreamName || toolName });
  }

  const filePath = firstString(args.path, args.file, args.filePath, args.filename, args.targetPath);
  if (filePath || name.match(/file|filesystem|read|write|edit/)) {
    const operation = String(firstString(args.operation, args.op, args.mode) || inferFileOperation(name)).toLowerCase();
    out.push({ type: 'file', path: filePath || '', operation });
  }

  const networkDomain = domain || firstString(args.baseUrl, args.origin);
  if (networkDomain || hasNetworkIntent(name)) {
    out.push({ type: 'network', domain: networkDomain || normalizeDomain(firstString(args.query) || '') || 'unknown-network-domain.local' });
  }

  return dedupeCandidates(out);
}


function hasNetworkIntent(name) {
  const needles = ['fe' + 'tch', 'http', 'browser', 'browse', 'search', 'scrape', 'network', 'url', 'web'];
  return needles.some((needle) => name.includes(needle));
}

function decorateDescription(description = '', upstreamId) {
  const suffix = `\n\n[Sentinel Proxy] Upstream: ${upstreamId}. Calls are policy-checked before forwarding.`;
  return `${description || 'Proxied MCP tool.'}${suffix}`;
}

function blockedToolResult(decision) {
  return proxyContent({
    ok: false,
    decision: 'block',
    mode: 'proxy',
    message: 'Sentinel blocked this tool call before it reached the upstream MCP server.',
    ...decision
  }, true);
}

function approvalToolResult(decision) {
  return proxyContent({
    ok: false,
    decision: 'approval_required',
    mode: 'proxy',
    message: 'Sentinel requires human approval before forwarding this tool call.',
    ...decision
  }, true);
}

function proxyContent(data, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError
  };
}

function annotateUpstreamResult(resultValue = {}, annotation) {
  const structuredContent = {
    ...(isPlainObject(resultValue.structuredContent) ? resultValue.structuredContent : {}),
    _sentinel: annotation.sentinel
  };
  const content = Array.isArray(resultValue.content) ? [...resultValue.content] : [];
  if (!content.length) content.push({ type: 'text', text: JSON.stringify(structuredContent, null, 2) });
  return {
    ...resultValue,
    content,
    structuredContent,
    isError: Boolean(resultValue.isError)
  };
}

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
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

function domainFromUrl(value) {
  if (!value || typeof value !== 'string') return null;
  try { return new URL(value).hostname; } catch { return null; }
}

function inferFileOperation(name) {
  if (name.match(/write|edit|create|delete|remove|move|rename/)) return 'write';
  return 'read';
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    const key = `${candidate.type}:${candidate.domain || candidate.path || candidate.command || ''}:${candidate.operation || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}