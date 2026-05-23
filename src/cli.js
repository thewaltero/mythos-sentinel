import fs from 'node:fs/promises';
import path from 'node:path';
import { VERSION, PRODUCT } from './version.js';
import { loadPolicy, defaultPolicy, checkPayment, checkCommand, checkFilesystemAccess, checkNetwork } from './core/policy.js';
import { exists, writeJson, readJson, ensureDir } from './core/fs.js';
import { scanPath } from './scanner/scan.js';
import { formatScanReport, formatPaymentDecision } from './report/format.js';
import { toSarif } from './report/sarif.js';
import { createSnapshot } from './core/snapshot.js';
import { createReceipt, writeReceipt, verifyReceipt } from './core/receipt.js';
import { runMcpServer } from './mcp/server.js';
import { runMcpProxy } from './mcp/proxy.js';
import { startDashboard } from './ui/server.js';
import { executeFallbackRoute, fetchBazaarResources, fetchBazaarSearch, importServicesFile, listServiceCategories, loadRouteScoreServices, recommendService, routeService, saveCustomServices, seedX402Services, serviceForDomain, scoreService } from './core/routescore.js';
import { appendTelemetryEvent, readTelemetryEvents, setTelemetryEnabled, telemetryEnabled, telemetryPrivacy, telemetrySummary } from './core/telemetry.js';
import { ingestX402ReceiptFile, readX402Receipts, summarizeX402Receipts } from './core/x402-receipts.js';

export async function runCli(argv) {
  const command = argv[0] || 'help';
  const args = parseArgs(argv.slice(1));

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    case 'version':
    case '--version':
    case '-v':
      console.log(`${PRODUCT} ${VERSION}`);
      return;
    case 'init':
      return initCommand(args);
    case 'scan':
      return scanCommand(args);
    case 'check-payment':
      return paymentCommand(args);
    case 'routescore':
      return routeScoreCommand(args);
    case 'telemetry':
      return telemetryCommand(args);
    case 'x402-receipt':
    case 'x402-receipts':
    case 'x402':
      return x402ReceiptCommand(args);
    case 'check-command':
      return commandGuardCommand(args);
    case 'check-file':
      return fileGuardCommand(args);
    case 'check-network':
      return networkGuardCommand(args);
    case 'snapshot':
      return snapshotCommand(args);
    case 'receipt':
      return receiptCommand(args);
    case 'verify':
      return verifyCommand(args);
    case 'mcp':
      return runMcpServer();
    case 'proxy':
    case 'mcp-proxy':
      return runMcpProxy({ policyPath: args.policy || 'mythos.policy.json', configPath: args.config });
    case 'ui':
    case 'dashboard':
      return uiCommand(args);
    case 'doctor':
      return doctorCommand();
    case 'policy':
      return policyCommand(args);
    default:
      throw new Error(`Unknown command: ${command}. Run mythos-sentinel help.`);
  }
}

async function initCommand(args) {
  const policyPath = args.policy || 'mythos.policy.json';
  const force = Boolean(args.force);
  const base = Boolean(args.base);
  const policy = structuredClone(defaultPolicy);
  policy.project = path.basename(process.cwd());
  if (base) {
    policy.payments.x402.trustedDomains = ['api.coinbase.com', 'api.developer.coinbase.com', 'api.exa.ai', 'www.x402.org', 'x402.org'];
    policy.payments.x402.maxPerRequestUSDC = 0.25;
    policy.payments.x402.maxDailyUSDC = 5;
    policy.network.allowedDomains.push('mainnet.base.org', 'base.org');
  }

  if ((await exists(policyPath)) && !force) throw new Error(`${policyPath} already exists. Use --force to overwrite.`);
  await writeJson(policyPath, policy);
  await ensureDir('.mythos/reports');
  await ensureDir('.mythos/snapshots');
  await fs.writeFile('.mythos/README.md', mythosReadme(), 'utf8');
  console.log(`Created ${policyPath}`);
  console.log('Created .mythos/reports and .mythos/snapshots');
  console.log(base ? 'Base/x402 guard enabled.' : 'Run with --base to preconfigure x402/Base policy.');
}

async function scanCommand(args) {
  const target = args._[0] || '.';
  const policy = await loadPolicy(args.policy || 'mythos.policy.json');
  const report = await scanPath(target, { policy, failOn: args['fail-on'] });
  const out = args.out;
  if (args.sarif) {
    const sarif = toSarif(report);
    if (out) await writeJson(out, sarif);
    else console.log(JSON.stringify(sarif, null, 2));
  } else if (args.json) {
    if (out) await writeJson(out, report);
    else console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatScanReport(report));
    if (out) await writeJson(out, report);
  }
  if (!report.summary.ok) process.exitCode = 2;
}

async function paymentCommand(args) {
  const policy = await loadPolicy(args.policy || 'mythos.policy.json');
  const decision = checkPayment({
    domain: required(args.domain, '--domain'),
    amountUSDC: required(args.amount, '--amount'),
    dailySpentUSDC: args['daily-spent'] || 0,
    unknownDailySpentUSDC: args['unknown-daily-spent'] || 0,
    routeScore: args['route-score'],
    category: args.category,
    knownService: Boolean(args['known-service']) || Boolean(serviceForDomain(args.domain, seedX402Services))
  }, policy);
  if (args.json) console.log(JSON.stringify(decision, null, 2));
  else console.log(formatPaymentDecision(decision));
  if (!decision.ok) process.exitCode = 3;
}


async function routeScoreCommand(args) {
  const sub = args._[0] || 'list';
  const policy = await loadPolicy(args.policy || 'mythos.policy.json');
  const services = await loadRouteScoreServices({ rootDir: process.cwd(), filePath: args.catalog });
  const summary = await telemetrySummary({ rootDir: process.cwd(), policy, services });

  if (sub === 'categories') {
    const categories = listServiceCategories();
    if (args.json) console.log(JSON.stringify(categories, null, 2));
    else {
      console.log(`RouteScore categories (${categories.length})`);
      for (const category of categories) console.log(`- ${category.id} · ${category.label} · aliases: ${(category.aliases || []).join(', ')}`);
    }
    return;
  }

  if (sub === 'list') {
    const scored = services.map((service) => scoreService(service, summary.telemetry[service.id] || {}));
    if (args.json) console.log(JSON.stringify(scored, null, 2));
    else {
      console.log(`RouteScore catalog (${scored.length} services)`);
      for (const service of scored) {
        const source = service.source ? ` · ${service.source}` : '';
        console.log(`- ${service.name} (${service.category}) ${service.domain} · score ${service.score}/100 · ${service.recommendation}${source}`);
      }
    }
    return;
  }

  if (sub === 'recommend') {
    const rec = recommendService({ category: args.category, maxPriceUSDC: args['max-price'], query: args.query, services, telemetry: summary.telemetry });
    if (args.json) console.log(JSON.stringify(rec, null, 2));
    else if (!rec.best) console.log(`No service found for category=${rec.category}`);
    else printRecommendation(rec);
    return;
  }

  if (sub === 'route') {
    const plan = routeService({ category: args.category, maxPriceUSDC: args['max-price'], query: args.query, minScore: args['min-score'] || 0, services, telemetry: summary.telemetry });
    attachPaymentDecisions(plan, policy);
    if (args.json) console.log(JSON.stringify(plan, null, 2));
    else printRoutePlan(plan);
    if (!plan.ok) process.exitCode = 3;
    return;
  }

  if (sub === 'fallback') {
    const plan = routeService({ category: args.category, maxPriceUSDC: args['max-price'], query: args.query, minScore: args['min-score'] || 0, services, telemetry: summary.telemetry });
    attachPaymentDecisions(plan, policy);
    const failIds = new Set(String(args['simulate-fail'] || '').split(',').map((x) => x.trim()).filter(Boolean));
    const result = await executeFallbackRoute({
      plan,
      executor: async (service) => {
        if (failIds.has(service.id) || failIds.has(service.domain) || failIds.has('primary') && service.id === plan.selected?.id) return { ok: false, error: 'simulated failure' };
        return { ok: true, result: { service: service.id, endpoint: service.endpoint, simulated: true } };
      }
    });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printFallbackResult(result);
    if (!result.ok) process.exitCode = 3;
    return;
  }

  if (sub === 'import') {
    const file = required(args._[1] || args.file, 'services file');
    const imported = await importServicesFile(file, { rootDir: process.cwd(), source: args.source || 'custom' });
    const existing = await loadRouteScoreServices({ rootDir: process.cwd(), includeSeed: false, filePath: args.catalog });
    const saved = await saveCustomServices([...existing, ...imported], { rootDir: process.cwd(), filePath: args.catalog, replace: true });
    if (args.json) console.log(JSON.stringify(saved, null, 2));
    else console.log(`Imported ${imported.length} services. Local RouteScore catalog now has ${saved.count} custom/live services at ${saved.path}`);
    return;
  }

  if (sub === 'sync-bazaar') {
    const mode = args.query ? 'search' : 'resources';
    const fetched = args.query
      ? await fetchBazaarSearch({ query: args.query, limit: args.limit || 20, network: args.network, asset: args.asset })
      : await fetchBazaarResources({ limit: args.limit || 100, offset: args.offset || 0, type: args.type || 'http' });
    const existing = args.replace ? [] : await loadRouteScoreServices({ rootDir: process.cwd(), includeSeed: false, filePath: args.catalog });
    const saved = await saveCustomServices([...existing, ...fetched.services], { rootDir: process.cwd(), filePath: args.catalog, replace: true });
    const payload = { ok: true, mode, fetched: fetched.services.length, saved: saved.count, path: saved.path, sourceUrl: fetched.url, pagination: fetched.pagination || null };
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(`Synced ${fetched.services.length} Bazaar services from ${mode}.`);
      console.log(`Local RouteScore catalog: ${saved.path} (${saved.count} custom/live services).`);
    }
    return;
  }

  if (sub === 'search-bazaar') {
    const fetched = await fetchBazaarSearch({ query: args.query || args._.slice(1).join(' '), limit: args.limit || 10, network: args.network, asset: args.asset });
    if (args.save) {
      const existing = await loadRouteScoreServices({ rootDir: process.cwd(), includeSeed: false, filePath: args.catalog });
      const saved = await saveCustomServices([...existing, ...fetched.services], { rootDir: process.cwd(), filePath: args.catalog, replace: true });
      fetched.saved = { path: saved.path, count: saved.count };
    }
    if (args.json) console.log(JSON.stringify(fetched, null, 2));
    else {
      console.log(`Bazaar search returned ${fetched.services.length} services${fetched.searchMethod ? ` (${fetched.searchMethod})` : ''}.`);
      for (const service of fetched.services) console.log(`- ${service.name} (${service.category}) ${service.domain} · $${service.priceUSDC} · ${service.endpoint}`);
      if (fetched.saved) console.log(`Saved to ${fetched.saved.path} (${fetched.saved.count} custom/live services).`);
    }
    return;
  }

  throw new Error(`Unknown routescore command: ${sub}`);
}
function printRecommendation(rec) {
  console.log(`Best: ${rec.best.name}`);
  console.log(`Endpoint: ${rec.best.endpoint}`);
  console.log(`Score: ${rec.best.score}/100 · ${rec.best.recommendation}`);
  console.log(`Price: ${rec.best.priceUSDC} USDC · Category: ${rec.best.category}`);
  for (const reason of rec.best.reasons) console.log(`- ${reason}`);
  if (rec.alternatives?.length) {
    console.log('Fallbacks:');
    for (const alt of rec.alternatives.slice(0, 3)) console.log(`- ${alt.name} · ${alt.score}/100 · $${alt.priceUSDC}`);
  }
}

function printRoutePlan(plan) {
  if (!plan.selected) {
    console.log(`No route found for category=${plan.category}`);
    return;
  }
  console.log(`Route: ${plan.selected.name}`);
  console.log(`Endpoint: ${plan.selected.endpoint}`);
  console.log(`Score: ${plan.selected.score}/100 · ${plan.selected.recommendation}`);
  console.log(`Price: ${plan.selected.priceUSDC} USDC · Category: ${plan.selected.category}`);
  if (plan.paymentDecision) console.log(`Policy: ${plan.paymentDecision.decision}${plan.paymentDecision.ok ? ' ✅' : ' ⚠️'}`);
  if (plan.fallbacks?.length) {
    console.log('Fallback plan:');
    for (const fallback of plan.fallbacks) console.log(`- ${fallback.name} · ${fallback.score}/100 · $${fallback.priceUSDC} · ${fallback.endpoint}`);
  }
  console.log(plan.note);
}



async function x402ReceiptCommand(args) {
  const sub = args._[0] || 'summary';
  const policy = await loadPolicy(args.policy || 'mythos.policy.json');

  if (sub === 'ingest') {
    const file = required(args.file || args._[1], '--file');
    const result = await ingestX402ReceiptFile(file, { rootDir: process.cwd(), policy, source: args.source || 'cli' });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`x402 receipt ingested: ${result.receipt.receiptId}`);
      console.log(`Domain: ${result.receipt.domain} · Amount: ${result.receipt.amountUSDC} ${result.receipt.asset} · Status: ${result.receipt.settlementStatus}`);
      console.log(`Telemetry: ${result.telemetry.stored ? 'stored locally' : result.telemetry.reason || 'not stored'}`);
    }
    return;
  }

  if (sub === 'list' || sub === 'events') {
    const receipts = await readX402Receipts({ rootDir: process.cwd(), limit: args.limit || 50 });
    if (args.json || sub === 'events') console.log(JSON.stringify(receipts, null, 2));
    else {
      console.log(`x402 receipts (${receipts.length})`);
      for (const receipt of receipts) console.log(`- ${receipt.receiptId} · ${receipt.domain} · ${receipt.amountUSDC} ${receipt.asset} · ${receipt.settlementStatus}`);
    }
    return;
  }

  if (sub === 'summary') {
    const summary = await summarizeX402Receipts({ rootDir: process.cwd(), limit: args.limit || 5000 });
    if (args.json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`x402 receipts: ${summary.receiptCount}`);
      console.log(`Settled: ${summary.settled} · Failed: ${summary.failed} · Pending/unknown: ${summary.pending}`);
      console.log(`Observed spend: ${summary.totalAmountUSDC.toFixed(6)} USDC`);
      for (const domain of summary.domains.slice(0, 10)) console.log(`- ${domain.domain}: ${domain.count} receipts · ${domain.totalAmountUSDC.toFixed(6)} USDC`);
    }
    return;
  }

  throw new Error(`Unknown x402-receipt command: ${sub}`);
}

function attachPaymentDecisions(plan, policy) {
  const services = [plan.selected, ...(plan.fallbacks || [])].filter(Boolean);
  plan.paymentDecisions = services.map((service) => ({
    serviceId: service.id,
    domain: service.domain,
    decision: checkPayment({
      domain: service.domain,
      amountUSDC: service.priceUSDC,
      routeScore: service.score,
      category: service.category,
      knownService: true
    }, policy)
  }));
  plan.paymentDecision = plan.paymentDecisions[0]?.decision || null;
  return plan;
}


function printFallbackResult(result) {
  if (!result.plan?.selected) {
    console.log('No fallback route available.');
    return;
  }
  console.log(`Fallback result: ${result.ok ? 'PASS' : 'FAIL'}`);
  console.log(`Selected: ${result.selected?.name || 'none'}`);
  console.log(`Fallback used: ${result.fallbackUsed ? 'yes' : 'no'}`);
  for (const attempt of result.attempts || []) console.log(`- attempt ${attempt.index + 1}: ${attempt.service.name} · ${attempt.ok ? 'ok' : 'failed'} · ${attempt.latencyMs}ms${attempt.error ? ` · ${attempt.error}` : ''}`);
}

async function telemetryCommand(args) {
  const sub = args._[0] || 'status';
  const policyPath = args.policy || 'mythos.policy.json';
  const policy = await loadPolicy(policyPath);

  if (sub === 'status') {
    const summary = await telemetrySummary({ rootDir: process.cwd(), policy });
    const payload = { enabled: telemetryEnabled(policy), privacy: telemetryPrivacy(policy), eventCount: summary.eventCount, services: summary.aggregates.length };
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(`Telemetry: ${payload.enabled ? 'enabled' : 'disabled'}`);
      console.log(`Events: ${payload.eventCount}`);
      console.log(`Services observed: ${payload.services}`);
      console.log(payload.privacy.note);
    }
    return;
  }

  if (sub === 'summary') {
    const summary = await telemetrySummary({ rootDir: process.cwd(), policy, limit: args.limit || 5000 });
    if (args.json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`Telemetry events: ${summary.eventCount}`);
      for (const item of summary.aggregates) {
        console.log(`- ${item.serviceId}: ${item.samples} samples · ${(item.successRate * 100).toFixed(1)}% success · ${item.medianLatencyMs ?? 'n/a'}ms median · ${item.totalAmountUSDC.toFixed(4)} USDC observed`);
      }
    }
    return;
  }

  if (sub === 'events') {
    const events = await readTelemetryEvents({ rootDir: process.cwd(), policy, limit: args.limit || 50 });
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  if (sub === 'record-demo') {
    const result = await appendTelemetryEvent({
      rootDir: process.cwd(),
      policy,
      event: {
        source: 'cli_demo',
        mode: 'manual',
        domain: args.domain || 'api.exa.ai',
        decision: args.decision || 'allow',
        ok: args.ok === undefined ? true : String(args.ok) !== 'false',
        latencyMs: args.latency || 900,
        amountUSDC: args.amount || 0.005,
        schemaOk: true,
        priceMatchedQuote: true
      }
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    const updated = await setTelemetryEnabled({ rootDir: process.cwd(), policy, enabled: sub === 'enable' });
    await writeJson(policyPath, updated);
    console.log(`Telemetry ${sub === 'enable' ? 'enabled' : 'disabled'} in ${policyPath}`);
    console.log(telemetryPrivacy(updated).note);
    return;
  }

  throw new Error(`Unknown telemetry command: ${sub}`);
}

async function commandGuardCommand(args) {
  const policy = await loadPolicy(args.policy || 'mythos.policy.json');
  const command = args.command || args._.join(' ');
  const decision = checkCommand({ command: required(command, '--command or command after --') }, policy);
  if (args.json) console.log(JSON.stringify(decision, null, 2));
  else console.log(formatPaymentDecision(decision));
  if (!decision.ok) process.exitCode = decision.decision === 'approval_required' ? 5 : 3;
}

async function fileGuardCommand(args) {
  const policy = await loadPolicy(args.policy || 'mythos.policy.json');
  const decision = checkFilesystemAccess({
    filePath: required(args.path || args.file || args._[0], '--path'),
    operation: args.operation || args.op || 'read'
  }, policy);
  if (args.json) console.log(JSON.stringify(decision, null, 2));
  else console.log(formatPaymentDecision(decision));
  if (!decision.ok) process.exitCode = 3;
}

async function networkGuardCommand(args) {
  const policy = await loadPolicy(args.policy || 'mythos.policy.json');
  const decision = checkNetwork({ domain: required(args.domain || args._[0], '--domain') }, policy);
  if (args.json) console.log(JSON.stringify(decision, null, 2));
  else console.log(formatPaymentDecision(decision));
  if (!decision.ok) process.exitCode = 3;
}

async function snapshotCommand(args) {
  const target = args._[0] || '.';
  const out = args.out || `.mythos/snapshots/${Date.now()}.json`;
  const snapshot = await createSnapshot(target);
  await writeJson(out, snapshot);
  console.log(`Snapshot written to ${out} (${snapshot.files.length} files)`);
}

async function receiptCommand(args) {
  const policy = await loadPolicy(args.policy || 'mythos.policy.json');
  const receipt = await createReceipt({
    beforePath: required(args.before, '--before'),
    afterPath: args.after,
    rootDir: args.path || '.',
    summary: args.summary || '',
    agent: args.agent || 'unknown-agent',
    provider: args.provider || 'unknown-provider',
    tool: args.tool || 'unknown-tool',
    policy
  });
  const out = args.out || 'mythos-receipt.json';
  await writeReceipt(out, receipt);
  console.log(`Receipt written to ${out}`);
  console.log(`Changed files: ${receipt.diff.changedCount} | Verification: ${receipt.verification.ok ? 'PASS' : 'FAIL'}`);
}

async function verifyCommand(args) {
  const policy = await loadPolicy(args.policy || 'mythos.policy.json');
  const result = await verifyReceipt({
    receiptPath: required(args.receipt, '--receipt'),
    rootDir: args.path || '.',
    policy,
    failOn: args['fail-on']
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Receipt verification: ${result.ok ? 'PASS ✅' : 'FAIL ⛔'}`);
    console.log(`Workspace drift since receipt: ${result.drift.changedCount}`);
    console.log(`Scan highest severity: ${result.scanSummary.highestSeverity}`);
    if (result.failingFindings?.length) {
      console.log('Failing findings:');
      for (const finding of result.failingFindings) console.log(`- ${finding.severity.toUpperCase()} ${finding.id} ${finding.file}:${finding.line}`);
    }
  }
  if (!result.ok) process.exitCode = 4;
}

async function policyCommand(args) {
  const sub = args._[0] || 'show';
  const policy = await loadPolicy(args.policy || 'mythos.policy.json');
  if (sub === 'show') console.log(JSON.stringify(policy, null, 2));
  else if (sub === 'schema') console.log(await fs.readFile(new URL('../schemas/policy.schema.json', import.meta.url), 'utf8'));
  else throw new Error(`Unknown policy command: ${sub}`);
}

async function uiCommand(args) {
  await startDashboard({
    port: args.port || 4317,
    host: args.host || '127.0.0.1',
    open: Boolean(args.open),
    demo: Boolean(args.demo)
  });
}

async function doctorCommand() {
  console.log(`${PRODUCT} ${VERSION}`);
  console.log(`Node: ${process.version}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`CWD: ${process.cwd()}`);
  console.log(`Policy: ${(await exists('mythos.policy.json')) ? 'found' : 'not found'}`);
}

function required(value, name) {
  if (value === undefined || value === null || value === '') throw new Error(`Missing required ${name}`);
  return value;
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      result._.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const [rawKey, rawValue] = token.slice(2).split('=');
      if (rawValue !== undefined) result[rawKey] = rawValue;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) result[rawKey] = argv[++i];
      else result[rawKey] = true;
    } else if (token.startsWith('-') && token.length > 1) {
      result[token.slice(1)] = true;
    } else {
      result._.push(token);
    }
  }
  return result;
}

function printHelp() {
  console.log(`
Mythos Sentinel ${VERSION}

Security layer for autonomous agents, MCP tools, skills, and x402/Base payments.

Usage:
  mythos-sentinel init [--base] [--force]
  mythos-sentinel scan [path] [--policy mythos.policy.json] [--json] [--sarif] [--out report.json] [--fail-on high]
  mythos-sentinel check-payment --domain api.example.com --amount 0.05 [--daily-spent 1.2] [--route-score 91]
  mythos-sentinel check-command -- "npm install left-pad"
  mythos-sentinel check-file --path src/index.js --operation write
  mythos-sentinel check-network --domain api.github.com
  mythos-sentinel routescore list|categories|recommend|route|fallback [--category web_search] [--max-price 0.05]
  mythos-sentinel routescore import services.yml
  mythos-sentinel routescore sync-bazaar [--query search] [--limit 50]
  mythos-sentinel telemetry status|enable|disable|summary|events
  mythos-sentinel x402-receipt ingest --file receipt.json | summary | list
  mythos-sentinel proxy [--policy mythos.policy.json] [--config proxy.json]
  mythos-sentinel snapshot [path] --out .mythos/snapshots/before.json
  mythos-sentinel receipt --before before.json --summary "agent task" --agent codex --provider openai --tool codex-cli
  mythos-sentinel verify --receipt mythos-receipt.json
  mythos-sentinel mcp
  mythos-sentinel ui [--host 127.0.0.1] [--port 4317] [--open] [--demo]
  mythos-sentinel doctor

Exit codes:
  0 pass, 2 scan policy failure, 3 guard/payment blocked, 4 receipt verification failure, 5 human approval required
`);
}

function mythosReadme() {
  return `# .mythos\n\nThis directory stores Sentinel reports, receipts, and snapshots.\n\nDo not commit secret material here. Commit receipts only when they are intentionally public.\n`;
}
