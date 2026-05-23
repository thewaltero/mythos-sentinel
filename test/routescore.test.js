import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendService, scoreService, seedX402Services, serviceForDomain } from '../src/core/routescore.js';

test('RouteScore recommends a seed web search service', () => {
  const rec = recommendService({ category: 'web_search', maxPriceUSDC: 0.05 });
  assert.equal(rec.ok, true);
  assert.equal(rec.best.category, 'web_search');
  assert.ok(rec.best.score >= 0);
});

test('RouteScore maps domains and scores services', () => {
  const service = serviceForDomain('https://api.exa.ai/search', seedX402Services);
  assert.equal(service.id, 'exa-search');
  const scored = scoreService(service, { successRate: 0.99, samples: 100, medianLatencyMs: 600 });
  assert.ok(scored.score > 80);
});
