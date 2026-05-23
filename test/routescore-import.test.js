import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchBazaarResources, importServicesFile, loadRouteScoreServices, routeService, saveCustomServices } from '../src/core/routescore.js';

test('RouteScore imports custom services from simple YAML', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mythos-routescore-'));
  const file = path.join(dir, 'services.yml');
  await fs.writeFile(file, `services:\n  - name: Custom Search\n    category: web_search\n    domain: api.custom.example\n    endpoint: https://api.custom.example/search\n    priceUSDC: 0.015\n    network: base\n    tags:\n      - search\n      - custom\n`, 'utf8');
  const imported = await importServicesFile(file, { rootDir: dir });
  assert.equal(imported.length, 1);
  assert.equal(imported[0].domain, 'api.custom.example');
  await saveCustomServices(imported, { rootDir: dir });
  const services = await loadRouteScoreServices({ rootDir: dir });
  assert.ok(services.some((service) => service.id === imported[0].id));
});

test('RouteScore normalizes Bazaar resources without network access', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    async json() {
      return {
        items: [{
          resource: 'https://api.weather.example/current',
          type: 'http',
          accepts: [{ network: 'eip155:8453', amount: '1000', asset: '0xusdc' }],
          metadata: { description: 'Weather data API', input: { city: 'Riga' }, output: { temperature: 7 } },
          lastUpdated: '2026-05-01T00:00:00.000Z'
        }],
        pagination: { limit: 20, offset: 0, total: 1 }
      };
    }
  });
  const fetched = await fetchBazaarResources({ limit: 20, fetchImpl: fakeFetch });
  assert.equal(fetched.services.length, 1);
  assert.equal(fetched.services[0].status, 'bazaar');
  assert.equal(fetched.services[0].priceUSDC, 0.001);
  assert.equal(fetched.services[0].category, 'general');
});

test('RouteScore route produces selected service and fallback plan', () => {
  const plan = routeService({
    category: 'web_search',
    maxPriceUSDC: 0.05,
    services: [
      { name: 'A Search', category: 'web_search', domain: 'a.example', endpoint: 'https://a.example/search', priceUSDC: 0.02, status: 'custom' },
      { name: 'B Search', category: 'web_search', domain: 'b.example', endpoint: 'https://b.example/search', priceUSDC: 0.01, status: 'custom' }
    ],
    telemetry: { 'custom-b-example-search': { successRate: 0.99, samples: 25, medianLatencyMs: 500 } }
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.selected.category, 'web_search');
  assert.ok(Array.isArray(plan.fallbacks));
});
