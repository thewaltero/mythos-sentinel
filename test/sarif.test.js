import test from 'node:test';
import assert from 'node:assert/strict';
import { toSarif } from '../src/report/sarif.js';

test('SARIF output has required 2.1.0 shape', () => {
  const report = {
    findings: [
      {
        id: 'MS-TEST-001',
        title: 'Test finding',
        recommendation: 'Fix it',
        severity: 'high',
        category: 'test',
        file: 'src/index.js',
        line: 1,
        evidence: 'demo',
        tags: ['demo']
      }
    ]
  };
  const sarif = toSarif(report);
  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs[0].tool.driver.rules[0].id, 'MS-TEST-001');
  assert.equal(sarif.runs[0].results[0].level, 'error');
});
