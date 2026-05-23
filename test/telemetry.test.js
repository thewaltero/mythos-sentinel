import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultPolicy } from '../src/core/policy.js';
import { appendTelemetryEvent, readTelemetryEvents, setTelemetryEnabled, telemetryEnabled, telemetrySummary } from '../src/core/telemetry.js';
import { scoreService, serviceForDomain } from '../src/core/routescore.js';
import { McpProxy } from '../src/mcp/proxy.js';

class TelemetryClient {
  constructor({ fail = false } = {}) {
    this.id = 'paid-tools';
    this.fail = fail;
    this.calls = [];
  }
  async start() {}
  async stop() {}
  async listTools() {
    return { tools: [{ name: 'x402_pay', description: 'Pay API', inputSchema: { type: 'object' } }] };
  }
  async callTool(name, args) {
    this.calls.push({ name, args });
    if (this.fail) throw new Error('upstream failed');
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } };
  }
}

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mythos-telemetry-'));
}

function enabledPolicy() {
  const policy = structuredClone(defaultPolicy);
  policy.payments.x402.unknown.maxPerRequestUSDC = 0.10;
  policy.payments.x402.unknown.requireApprovalAboveUSDC = 0.10;
  return setTelemetryEnabled({ rootDir: process.cwd(), policy, enabled: true });
}

test('telemetry is opt-in and stores sanitized local events only when enabled', async () => {
  const root = await tempRoot();
  const disabled = structuredClone(defaultPolicy);
  assert.equal(telemetryEnabled(disabled), false);
  const skipped = await appendTelemetryEvent({ rootDir: root, policy: disabled, event: { domain: 'api.exa.ai', ok: true, latencyMs: 100 } });
  assert.equal(skipped.stored, false);

  const policy = await setTelemetryEnabled({ rootDir: root, policy: structuredClone(defaultPolicy), enabled: true });
  const stored = await appendTelemetryEvent({ rootDir: root, policy, event: { domain: 'api.exa.ai', ok: true, latencyMs: 100, response: 'secret' } });
  assert.equal(stored.stored, true);
  const events = await readTelemetryEvents({ rootDir: root, policy });
  assert.equal(events.length, 1);
  assert.equal(events[0].domain, 'api.exa.ai');
  assert.equal(events[0].response, undefined);
});

test('telemetry summary feeds passive RouteScore reliability scoring', async () => {
  const root = await tempRoot();
  const policy = await setTelemetryEnabled({ rootDir: root, policy: structuredClone(defaultPolicy), enabled: true });
  await appendTelemetryEvent({ rootDir: root, policy, event: { domain: 'api.exa.ai', ok: true, latencyMs: 600, amountUSDC: 0.005 } });
  await appendTelemetryEvent({ rootDir: root, policy, event: { domain: 'api.exa.ai', ok: true, latencyMs: 800, amountUSDC: 0.005 } });
  const summary = await telemetrySummary({ rootDir: root, policy });
  assert.equal(summary.eventCount, 2);
  assert.ok(summary.telemetry['exa-search'].successRate > 0.9);
  const service = serviceForDomain('api.exa.ai');
  const scored = scoreService(service, summary.telemetry[service.id]);
  assert.ok(scored.telemetry.samples >= 2);
  assert.ok(scored.reasons.some((reason) => reason.includes('passive samples')));
});

test('MCP proxy records passive routed-call telemetry for allowed paid API calls', async () => {
  const root = await tempRoot();
  const policy = await enabledPolicy();
  const fake = new TelemetryClient();
  const proxy = new McpProxy({ policy, proxyConfig: { upstreams: [] }, clients: [fake], rootDir: root });
  await proxy.start();
  const response = await proxy.handleMessage({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'x402_pay', arguments: { domain: 'api.exa.ai', amountUSDC: 0.005 } }
  });
  assert.equal(response.result.structuredContent._sentinel.decision, 'allow');
  const events = await readTelemetryEvents({ rootDir: root, policy });
  assert.equal(events.length, 1);
  assert.equal(events[0].domain, 'api.exa.ai');
  assert.equal(events[0].ok, true);
});
