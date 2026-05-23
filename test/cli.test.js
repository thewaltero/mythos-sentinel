import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const BIN = new URL('../bin/mythos-sentinel.js', import.meta.url).pathname;

test('CLI doctor exits successfully', () => {
  const result = spawnSync(process.execPath, [BIN, 'doctor'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Mythos Sentinel/);
});

test('CLI check-command blocks dangerous command', () => {
  const result = spawnSync(process.execPath, [BIN, 'check-command', '--', 'rm -rf /'], { encoding: 'utf8' });
  assert.equal(result.status, 3);
  assert.match(result.stdout, /BLOCK/);
});
