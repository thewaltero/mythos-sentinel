import test from 'node:test';
import assert from 'node:assert/strict';
import { createUiServer } from '../src/ui/server.js';
import { VERSION } from '../src/version.js';

test('dashboard server exposes status and config APIs', async () => {
  const server = await createUiServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const status = await fetch(`${base}/api/status`).then((r) => r.json());
    assert.equal(status.product, 'Mythos Sentinel');
    assert.equal(status.version, VERSION);

    const configs = await fetch(`${base}/api/configs`).then((r) => r.json());
    assert.match(configs.mcp, /mythos-sentinel/);
    assert.match(configs.codex, /Sentinel/);
  } finally {
    server.close();
  }
});

test('dashboard payment API allows tiny unknown trial and gates larger unknown spend', async () => {
  const server = await createUiServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const decision = await fetch(`http://127.0.0.1:${port}/api/check-payment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'fresh-api.example', amount: 0.01 })
    }).then((r) => r.json());
    assert.equal(decision.ok, true);
    assert.equal(decision.decision, 'allow');

    const gated = await fetch(`http://127.0.0.1:${port}/api/check-payment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'fresh-api.example', amount: 0.05 })
    }).then((r) => r.json());
    assert.equal(gated.ok, false);
    assert.equal(gated.decision, 'approval_required');
  } finally {
    server.close();
  }
});
