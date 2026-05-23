import test from 'node:test';
import assert from 'node:assert/strict';
import { executeFallbackRoute, listServiceCategories, normalizeServiceList, routeService } from '../src/core/routescore.js';

test('RouteScore supports expanded category aliases', () => {
  const [service] = normalizeServiceList([{ name: 'Browser Tool', category: 'browser_session', domain: 'browser.example', endpoint: 'https://browser.example/session', priceUSDC: 0.01 }]);
  assert.equal(service.category, 'browser');
  assert.ok(listServiceCategories().some((category) => category.id === 'browser'));
});

test('executeFallbackRoute retries fallbacks until a service succeeds', async () => {
  const services = [
    { id: 'a', name: 'A Search', category: 'web_search', domain: 'a.example', endpoint: 'https://a.example/search', priceUSDC: 0.01, status: 'custom' },
    { id: 'b', name: 'B Search', category: 'web_search', domain: 'b.example', endpoint: 'https://b.example/search', priceUSDC: 0.02, status: 'custom' }
  ];
  const plan = routeService({ category: 'web_search', services, telemetry: { a: { successRate: 0.99, samples: 20 }, b: { successRate: 0.95, samples: 15 } } });
  const result = await executeFallbackRoute({
    plan,
    executor: async (service) => service.id === plan.selected.id ? { ok: false, error: 'simulated failure' } : { ok: true, result: { service: service.id } }
  });
  assert.equal(result.ok, true);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.attempts.length, 2);
});
