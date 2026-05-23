const $ = (id) => document.getElementById(id);
let policy = null;
let configs = null;
let routeCatalog = null;
let telemetrySummary = null;

async function api(path, body) {
  const res = await fetch(path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

function listToTextarea(values = []) { return values.join('\n'); }
function textareaToList(value = '') { return value.split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean); }

async function boot() {
  const status = await api('/api/status');
  $('policyStatus').textContent = status.policyFound ? 'found' : 'not found';
  $('versionStatus').textContent = status.version;
  $('workspaceStatus').textContent = status.workspace.split('/').slice(-2).join('/');
  await loadPolicy();
  configs = await api('/api/configs');
  $('proxyConfig').textContent = configs.proxy;
  $('mcpConfig').textContent = configs.mcp;
  $('agentRules').textContent = configs.codex;
  await loadTelemetry();
  await loadRouteScore();
}

async function loadPolicy() {
  policy = await api('/api/policy');
  const x402 = policy.payments?.x402 || {};
  $('strategy').value = x402.strategy || 'balanced';
  $('strategyStatus').textContent = x402.strategy || 'balanced';
  $('trustedDomains').value = listToTextarea(x402.trustedDomains?.length ? x402.trustedDomains : x402.allowedDomains || []);
  $('maxPerRequest').value = x402.maxPerRequestUSDC ?? '';
  $('approvalAbove').value = x402.requireApprovalAboveUSDC ?? '';
  $('maxDaily').value = x402.maxDailyUSDC ?? '';
  $('unknownMax').value = x402.unknown?.maxPerRequestUSDC ?? '';
  $('unknownDailyMax').value = x402.unknown?.maxDailyUSDC ?? '';
  $('autoScore').value = x402.routeScore?.autoAllowMinScore ?? '';
}

async function savePolicy() {
  const next = structuredClone(policy);
  next.payments ??= {};
  next.payments.x402 ??= {};
  next.payments.x402.strategy = $('strategy').value;
  next.payments.x402.trustedDomains = textareaToList($('trustedDomains').value);
  next.payments.x402.allowedDomains = [];
  next.payments.x402.maxPerRequestUSDC = Number($('maxPerRequest').value || 0);
  next.payments.x402.requireApprovalAboveUSDC = Number($('approvalAbove').value || 0);
  next.payments.x402.maxDailyUSDC = Number($('maxDaily').value || 0);
  next.payments.x402.unknown ??= {};
  next.payments.x402.unknown.allowTrial = true;
  next.payments.x402.unknown.maxPerRequestUSDC = Number($('unknownMax').value || 0);
  next.payments.x402.unknown.maxDailyUSDC = Number($('unknownDailyMax').value || 0);
  next.payments.x402.unknown.requireApprovalAboveUSDC = Number($('unknownMax').value || 0);
  next.payments.x402.routeScore ??= {};
  next.payments.x402.routeScore.autoAllowMinScore = Number($('autoScore').value || 80);
  const saved = await api('/api/policy', next);
  policy = saved.policy;
  $('strategyStatus').textContent = next.payments.x402.strategy;
  showDecision({ decision: 'saved', ok: true, reasons: ['mythos.policy.json updated'] });
}

async function loadRouteScore() {
  routeCatalog = await api('/api/routescore/catalog');
  $('routeMetrics').innerHTML = [
    metric('services', routeCatalog.summary.services),
    metric('prefer', routeCatalog.summary.prefer),
    metric('trial', routeCatalog.summary.trial),
    metric('avoid', routeCatalog.summary.avoid),
    metric('samples', routeCatalog.summary.passiveSamples || 0)
  ].join('');
  $('routeCatalog').innerHTML = routeCatalog.services.map(serviceCard).join('');
}

function metric(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function serviceCard(service) {
  return `<article class="service-card">
    <div class="service-top"><strong>${escapeHtml(service.name)}</strong><span class="score ${escapeHtml(service.risk)}">${service.score}</span></div>
    <div class="muted-row">${escapeHtml(service.category)} · ${escapeHtml(service.domain)} · $${escapeHtml(service.priceUSDC)}</div>
    <p>${escapeHtml(service.note)}</p>
    <small>${escapeHtml(service.recommendation)} · ${escapeHtml(service.reasons.slice(0, 2).join(' · '))}</small>
  </article>`;
}

async function loadTelemetry() {
  const status = await api('/api/telemetry/status');
  telemetrySummary = await api('/api/telemetry/summary');
  $('telemetryStatus').textContent = status.enabled ? 'enabled' : 'disabled';
  $('telemetryMetrics').innerHTML = [
    metric('enabled', status.enabled ? 'yes' : 'no'),
    metric('events', telemetrySummary.eventCount),
    metric('services', telemetrySummary.aggregates.length),
    metric('privacy', 'local')
  ].join('');
  $('telemetrySummary').innerHTML = telemetrySummary.aggregates.length
    ? telemetrySummary.aggregates.map((item) => `<article class="service-card compact-card"><div class="service-top"><strong>${escapeHtml(item.serviceId)}</strong><span class="score low">${Math.round(item.successRate * 100)}%</span></div><div class="muted-row">${item.samples} samples · ${item.medianLatencyMs ?? 'n/a'}ms median · $${Number(item.totalAmountUSDC || 0).toFixed(4)} observed</div><small>Last observed ${escapeHtml(item.lastObservedAt || 'never')}</small></article>`).join('')
    : '<div class="quiet-box">No local telemetry yet. Enable it, route real calls through proxy, or create a demo event.</div>';
}

async function setTelemetry(enabled) {
  await api(enabled ? '/api/telemetry/enable' : '/api/telemetry/disable', {});
  await loadPolicy();
  await loadTelemetry();
  await loadRouteScore();
  showDecision({ ok: true, decision: enabled ? 'telemetry_enabled' : 'telemetry_disabled', reasons: [enabled ? 'local opt-in telemetry enabled' : 'local telemetry disabled', 'No prompts, responses, secrets, or wallet balances are stored.'] });
}

function showDecision(decision) {
  const label = decision.ok ? 'ALLOW ✅' : decision.decision === 'approval_required' ? 'APPROVAL REQUIRED ⚠️' : 'BLOCK ⛔';
  
  // Update console borders based on state
  $('resultSummary').classList.remove('empty', 'state-allow', 'state-approval', 'state-block');
  if (decision.ok) {
    $('resultSummary').classList.add('state-allow');
  } else if (decision.decision === 'approval_required') {
    $('resultSummary').classList.add('state-approval');
  } else {
    $('resultSummary').classList.add('state-block');
  }
  
  $('resultSummary').textContent = `${label}\n${decision.subject ? `Subject: ${decision.subject}\n` : ''}${decision.trustTier ? `Trust: ${decision.trustTier}\n` : ''}${decision.amountUSDC !== undefined ? `Amount: ${decision.amountUSDC} USDC\n` : ''}${decision.routeScore !== null && decision.routeScore !== undefined ? `RouteScore: ${decision.routeScore}/100\n` : ''}${(decision.reasons || []).map((r) => `- ${r}`).join('\n')}`;
  $('findings').innerHTML = '';
}

function showReport(report) {
  // Update console borders based on scan result
  $('resultSummary').classList.remove('empty', 'state-allow', 'state-approval', 'state-block');
  if (report.summary.ok) {
    $('resultSummary').classList.add('state-allow');
  } else {
    $('resultSummary').classList.add('state-block');
  }
  
  $('resultSummary').textContent = `Scan complete\nFindings: ${report.summary.findingCount}\nHighest: ${report.summary.highestSeverity.toUpperCase()}\nStatus: ${report.summary.ok ? 'PASS' : 'REVIEW'}`;
  $('findings').innerHTML = report.findings.slice(0, 12).map((f) => `
    <div class="finding">
      <div class="top"><strong>${escapeHtml(f.id)} · ${escapeHtml(f.title)}</strong><span class="badge ${f.severity}">${f.severity}</span></div>
      <div>${escapeHtml(f.file)}:${f.line}</div>
      <small>${escapeHtml(f.recommendation || '')}</small>
    </div>`).join('') || '<div class="finding"><strong>No findings.</strong><small>This workspace is clean under the current scan rules.</small></div>';
}

function showRecommendation(rec) {
  if (!rec.best) return showDecision({ ok: false, decision: 'approval_required', reasons: [rec.note] });
  showDecision({
    ok: true,
    decision: 'allow',
    subject: rec.best.domain,
    routeScore: rec.best.score,
    reasons: [`Recommended ${rec.best.name}`, `endpoint ${rec.best.endpoint}`, `price ${rec.best.priceUSDC} USDC`, ...rec.best.reasons]
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

$('initBase').addEventListener('click', async () => {
  const res = await api('/api/init', { base: true, force: true });
  policy = res.policy;
  await loadPolicy();
  showDecision({ ok: true, decision: 'allow', reasons: ['Adaptive Base/x402 policy initialized'] });
});

$('createDemo').addEventListener('click', async () => showReport((await api('/api/demo/create', {})).report));
$('savePolicy').addEventListener('click', savePolicy);
$('recommendRoute').addEventListener('click', async () => showRecommendation(await api('/api/routescore/recommend', { category: $('routeCategory').value, maxPriceUSDC: 0.05 })));
$('checkPayment').addEventListener('click', async () => showDecision(await api('/api/check-payment', {
  domain: $('payDomain').value || 'api.exa.ai',
  amount: Number($('payAmount').value || 0.01),
  routeScore: $('payScore').value ? Number($('payScore').value) : undefined
})));
$('checkCommand').addEventListener('click', async () => showDecision(await api('/api/check-command', { command: $('commandInput').value || 'npm test' })));
$('checkFile').addEventListener('click', async () => showDecision(await api('/api/check-file', { path: $('filePath').value || '.env', operation: $('fileOp').value || 'read' })));
$('scanWorkspace').addEventListener('click', async () => showReport((await api('/api/scan', { target: '.', failOn: 'none' })).report));
$('enableTelemetry').addEventListener('click', async () => setTelemetry(true));
$('disableTelemetry').addEventListener('click', async () => setTelemetry(false));
$('recordTelemetryDemo').addEventListener('click', async () => {
  const res = await api('/api/routescore/event', { domain: 'api.exa.ai', ok: true, latencyMs: 760, amountUSDC: 0.005, decision: 'allow', source: 'dashboard_demo' });
  await loadTelemetry();
  await loadRouteScore();
  showDecision({ ok: true, decision: res.stored ? 'telemetry_stored' : 'telemetry_disabled', reasons: [res.message] });
});

document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const id = button.getAttribute('data-copy');
    await navigator.clipboard.writeText($(id).textContent);
    const before = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = before; }, 1100);
  });
});

boot().catch((error) => {
  $('resultSummary').classList.remove('empty');
  $('resultSummary').textContent = `Dashboard error: ${error.message}`;
});
