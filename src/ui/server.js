import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { VERSION, PRODUCT } from '../version.js';
import { exists, ensureDir, writeJson } from '../core/fs.js';
import { loadPolicy, defaultPolicy, checkPayment, checkCommand, checkFilesystemAccess, checkNetwork } from '../core/policy.js';
import { scanPath } from '../scanner/scan.js';
import { formatScanReport } from '../report/format.js';
import { loadRouteScoreServices, recommendService, serviceForDomain, scoreService, passiveTelemetryEvent } from '../core/routescore.js';
import { appendTelemetryEvent, readTelemetryEvents, setTelemetryEnabled, telemetryEnabled, telemetryPrivacy, telemetrySummary } from '../core/telemetry.js';
import { ingestX402Receipt, summarizeX402Receipts } from '../core/x402-receipts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, 'static');

export async function startDashboard(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const host = normalizeDashboardHost(options.host || '127.0.0.1');
  const port = normalizeDashboardPort(options.port || 4317);
  const server = await createUiServer({ cwd, demo: Boolean(options.demo) });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = createDashboardUrl(host, actualPort);

  console.log(`${PRODUCT} Dashboard ${VERSION}`);
  console.log(`Workspace: ${cwd}`);
  console.log(`Open: ${url}`);
  console.log('Tip: in GitHub Codespaces, use the forwarded port link.');

  if (options.open) openBrowser(url);

  return { server, url, port: actualPort };
}

export async function createUiServer({ cwd = process.cwd(), demo = false } = {}) {
  const root = path.resolve(cwd);

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') return serveFile(res, 'index.html', 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/assets/styles.css') return serveFile(res, 'styles.css', 'text/css; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/assets/app.js') return serveFile(res, 'app.js', 'text/javascript; charset=utf-8');
      if (url.pathname === '/api/status') return json(res, await getStatus(root, demo));
      if (url.pathname === '/api/policy' && req.method === 'GET') return json(res, await loadPolicyForRoot(root));
      if (url.pathname === '/api/policy' && req.method === 'POST') return json(res, await savePolicy(root, await bodyJson(req)));
      if (url.pathname === '/api/init' && req.method === 'POST') return json(res, await initWorkspace(root, await bodyJson(req)));
      if (url.pathname === '/api/scan' && req.method === 'POST') return json(res, await scanWorkspace(root, await bodyJson(req)));
      if (url.pathname === '/api/check-payment' && req.method === 'POST') return json(res, await checkPaymentApi(root, await bodyJson(req)));
      if (url.pathname === '/api/check-command' && req.method === 'POST') return json(res, await checkCommandApi(root, await bodyJson(req)));
      if (url.pathname === '/api/check-file' && req.method === 'POST') return json(res, await checkFileApi(root, await bodyJson(req)));
      if (url.pathname === '/api/check-network' && req.method === 'POST') return json(res, await checkNetworkApi(root, await bodyJson(req)));
      if (url.pathname === '/api/demo/create' && req.method === 'POST') return json(res, await createDemoProject(root));
      if (url.pathname === '/api/routescore/catalog') return json(res, await buildRouteScoreCatalog(root));
      if (url.pathname === '/api/routescore/recommend' && req.method === 'POST') return json(res, await recommendRouteScore(await bodyJson(req), root));
      if (url.pathname === '/api/routescore/event' && req.method === 'POST') return json(res, await routeScoreEvent(root, await bodyJson(req)));
      if (url.pathname === '/api/x402/receipts/summary') return json(res, await summarizeX402Receipts({ rootDir: root }));
      if (url.pathname === '/api/x402/receipts/ingest' && req.method === 'POST') return json(res, await ingestX402Receipt(await bodyJson(req), { rootDir: root, policy: await loadPolicyForRoot(root), source: 'dashboard' }));
      if (url.pathname === '/api/telemetry/status') return json(res, await telemetryStatus(root));
      if (url.pathname === '/api/telemetry/summary') return json(res, await telemetrySummaryApi(root));
      if (url.pathname === '/api/telemetry/events') return json(res, await telemetryEventsApi(root, url));
      if (url.pathname === '/api/telemetry/enable' && req.method === 'POST') return json(res, await setTelemetry(root, true));
      if (url.pathname === '/api/telemetry/disable' && req.method === 'POST') return json(res, await setTelemetry(root, false));
      if (url.pathname === '/api/configs') return json(res, buildConfigs());
      return json(res, { error: 'Not found' }, 404);
    } catch (error) {
      return json(res, { error: error.message || String(error) }, 500);
    }
  });
}

async function getStatus(root, demo) {
  const policyPath = path.join(root, 'mythos.policy.json');
  return {
    product: PRODUCT,
    version: VERSION,
    workspace: root,
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    policyFound: await exists(policyPath),
    demoMode: demo
  };
}

async function loadPolicyForRoot(root) {
  return loadPolicy(path.join(root, 'mythos.policy.json'));
}

async function savePolicy(root, body) {
  if (!body || typeof body !== 'object') throw new Error('Policy body must be a JSON object.');
  const policyPath = path.join(root, 'mythos.policy.json');
  await writeJson(policyPath, body);
  return { ok: true, path: policyPath, policy: body };
}

async function initWorkspace(root, body = {}) {
  const policyPath = path.join(root, 'mythos.policy.json');
  if ((await exists(policyPath)) && !body.force) return { ok: false, reason: 'policy_exists', message: 'mythos.policy.json already exists. Use force to overwrite.' };
  const policy = structuredClone(defaultPolicy);
  policy.project = path.basename(root);
  if (body.base !== false) {
    policy.version = '0.10';
    policy.payments.x402.strategy = 'balanced';
    policy.payments.x402.trustedDomains = ['api.coinbase.com', 'api.developer.coinbase.com', 'api.exa.ai', 'www.x402.org', 'x402.org'];
    policy.payments.x402.allowedDomains = [];
    policy.payments.x402.maxPerRequestUSDC = 0.25;
    policy.payments.x402.maxDailyUSDC = 5;
    policy.payments.x402.requireApprovalAboveUSDC = 0.25;
    policy.network.allowedDomains.push('mainnet.base.org', 'base.org', 'api.exa.ai');
  }
  await writeJson(policyPath, policy);
  await ensureDir(path.join(root, '.mythos/reports'));
  await ensureDir(path.join(root, '.mythos/snapshots'));
  return { ok: true, path: policyPath, policy };
}

async function scanWorkspace(root, body = {}) {
  const target = resolveInside(root, body.target || '.');
  const policy = await loadPolicyForRoot(root);
  const report = await scanPath(target, { policy, failOn: body.failOn || 'none' });
  let text = '';
  try { text = formatScanReport(report); } catch { text = ''; }
  return { ok: report.summary.ok, report, text };
}

async function checkPaymentApi(root, body = {}) {
  const policy = await loadPolicyForRoot(root);
  return checkPayment({
    domain: body.domain,
    amountUSDC: body.amount,
    dailySpentUSDC: body.dailySpent || 0,
    unknownDailySpentUSDC: body.unknownDailySpent || 0,
    routeScore: body.routeScore,
    category: body.category,
    knownService: Boolean(body.knownService) || Boolean(serviceForDomain(body.domain, await loadRouteScoreServices({ rootDir: root })))
  }, policy);
}

async function checkCommandApi(root, body = {}) {
  const policy = await loadPolicyForRoot(root);
  return checkCommand({ command: body.command }, policy);
}

async function checkFileApi(root, body = {}) {
  const policy = await loadPolicyForRoot(root);
  return checkFilesystemAccess({ filePath: body.path, operation: body.operation || 'read' }, policy);
}

async function checkNetworkApi(root, body = {}) {
  const policy = await loadPolicyForRoot(root);
  return checkNetwork({ domain: body.domain }, policy);
}

async function createDemoProject(root) {
  const demoDir = path.join(root, '.mythos', 'demo-workspace');
  await ensureDir(demoDir);
  await fs.writeFile(path.join(demoDir, '.env'), `${'PRIVATE'}_${'KEY'}=demo_fake_key_do_not_use\n`, 'utf8');
  await fs.writeFile(path.join(demoDir, 'agent.js'), 'console.log("demo agent requesting tools and x402 payments")\n', 'utf8');
  await fs.writeFile(path.join(demoDir, 'skill.md'), 'Demo skill: ask Sentinel before shell, file, network, and payment actions.\n', 'utf8');
  const policy = await loadPolicyForRoot(root);
  const report = await scanPath(demoDir, { policy, failOn: 'none', ignore: [] });
  return { ok: true, path: demoDir, report };
}

async function buildRouteScoreCatalog(root) {
  const policy = await loadPolicyForRoot(root);
  const telemetry = await telemetrySummary({ rootDir: root, policy });
  const availableServices = await loadRouteScoreServices({ rootDir: root });
  const services = availableServices.map((service) => scoreService(service, telemetry.telemetry[service.id] || {}));
  const summary = {
    services: services.length,
    prefer: services.filter((service) => service.recommendation === 'prefer').length,
    trial: services.filter((service) => service.recommendation === 'trial_only').length,
    avoid: services.filter((service) => service.recommendation === 'avoid_or_approval').length
  };
  return { ok: true, summary: { ...summary, passiveSamples: services.reduce((sum, service) => sum + Number(service.telemetry?.samples || 0), 0), telemetryEvents: telemetry.eventCount, telemetryEnabled: telemetryEnabled(policy) }, services, updatedAt: new Date().toISOString() };
}

async function recommendRouteScore(body = {}, root = process.cwd()) {
  const policy = await loadPolicyForRoot(root);
  const summary = await telemetrySummary({ rootDir: root, policy });
  const services = await loadRouteScoreServices({ rootDir: root });
  return recommendService({ category: body.category, maxPriceUSDC: body.maxPriceUSDC, query: body.query, services, telemetry: summary.telemetry });
}

async function routeScoreEvent(root, body = {}) {
  const event = passiveTelemetryEvent(body);
  const policy = await loadPolicyForRoot(root);
  const stored = await appendTelemetryEvent({ rootDir: root, policy, event });
  return { ok: true, event: stored.event || event, stored: stored.stored, privacy: stored.privacy, message: stored.stored ? 'Telemetry event stored locally.' : 'Telemetry disabled; event normalized but not persisted.' };
}

async function telemetryStatus(root) {
  const policy = await loadPolicyForRoot(root);
  const summary = await telemetrySummary({ rootDir: root, policy });
  return { ok: true, enabled: telemetryEnabled(policy), privacy: telemetryPrivacy(policy), eventCount: summary.eventCount, servicesObserved: summary.aggregates.length };
}

async function telemetrySummaryApi(root) {
  const policy = await loadPolicyForRoot(root);
  return telemetrySummary({ rootDir: root, policy });
}

async function telemetryEventsApi(root, url) {
  const policy = await loadPolicyForRoot(root);
  return { ok: true, events: await readTelemetryEvents({ rootDir: root, policy, limit: url.searchParams.get('limit') || 100 }) };
}

async function setTelemetry(root, enabled) {
  const policyPath = path.join(root, 'mythos.policy.json');
  const policy = await loadPolicyForRoot(root);
  const updated = await setTelemetryEnabled({ rootDir: root, policy, enabled });
  await writeJson(policyPath, updated);
  return { ok: true, enabled, privacy: telemetryPrivacy(updated), policy: updated };
}

function buildConfigs() {
  const proxy = {
    mcpServers: {
      'mythos-sentinel-proxy': {
        command: 'npx',
        args: ['mythos-sentinel', 'proxy']
      }
    }
  };
  const direct = {
    mcpServers: {
      'mythos-sentinel': { command: 'npx', args: ['mythos-sentinel', 'mcp'] }
    }
  };

  return {
    proxy: JSON.stringify(proxy, null, 2),
    mcp: JSON.stringify(direct, null, 2),
    proxyPolicy: JSON.stringify({
      mcpProxy: {
        enabled: true,
        mode: 'enforce',
        approvalMode: 'return_error',
        toolNameStrategy: 'preserve_unless_collision',
        upstreams: [
          { id: 'exa', command: 'npx', args: ['-y', '@example/exa-mcp-server'] },
          { id: 'browser', command: 'npx', args: ['-y', '@example/browser-mcp-server'] }
        ]
      }
    }, null, 2),
    codex: [
      '# Mythos Sentinel agent rules',
      'Prefer connecting through mythos-sentinel proxy instead of direct tool servers when wallets, shell, files, or paid APIs are enabled.',
      'If proxy mode is unavailable, call sentinel_check_command, sentinel_check_file, sentinel_check_network, and sentinel_check_x402_payment before risky actions.',
      'For x402/Base payments, respect Sentinel decisions: allow continues, approval_required asks the human, block stops immediately.',
      'Never read .env, wallet keys, SSH keys, or seed phrases unless Sentinel explicitly allows it.'
    ].join('\n'),
    cursorRule: [
      '---',
      'description: Mythos Sentinel runtime proxy and guardrails for agent actions',
      'alwaysApply: true',
      '---',
      'Use mythos-sentinel proxy for tool access when available. Do not bypass it for x402 payments, shell, file, or network actions.',
      'If a Sentinel decision is approval_required, ask the human before continuing. If block, stop.'
    ].join('\n')
  };
}

function resolveInside(root, requested) {
  const resolved = path.resolve(root, requested || '.');
  if (!resolved.startsWith(root) && !resolved.startsWith(os.tmpdir())) throw new Error(`Refusing to access path outside workspace: ${requested}`);
  return resolved;
}

async function serveFile(res, filename, contentType) {
  const filePath = path.join(STATIC_DIR, filename);
  const data = await fs.readFile(filePath);
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(data);
}

async function bodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function json(res, payload, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function normalizeDashboardHost(host) {
  const value = String(host || '127.0.0.1').trim();

  if (value === 'localhost' || value === '127.0.0.1' || value === '0.0.0.0' || value === '::1' || value === '[::1]') {
    return value;
  }

  throw new Error(`Refusing unsafe dashboard host: ${value}`);
}

function normalizeDashboardPort(port) {
  const value = Number(port);

  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid dashboard port: ${port}`);
  }

  return value;
}

function createDashboardUrl(host, port) {
  const safeHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  return `http://${safeHost}:${normalizeDashboardPort(port)}`;
}

function openBrowser(url) {
  const parsed = new URL(url);

  if (parsed.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error(`Refusing to open unsafe dashboard URL: ${url}`);
  }

  const launch = browserLaunchCommand(process.platform, parsed.toString());
  const child = spawn(launch.command, launch.args, {
    detached: true,
    stdio: 'ignore',
    shell: false
  });

  child.unref();
}

function browserLaunchCommand(platform, url) {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}
