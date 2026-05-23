import { scanPath } from '../src/scanner/scan.js';
import { loadPolicy } from '../src/core/policy.js';

const policy = await loadPolicy('mythos.policy.json');
const report = await scanPath('.', { policy, failOn: 'none' });
if (report.summary.findingCount !== 0) {
  console.error(`Expected clean self-scan, found ${report.summary.findingCount} finding(s).`);
  for (const finding of report.findings.slice(0, 20)) {
    console.error(`- ${finding.severity.toUpperCase()} ${finding.id} ${finding.file}:${finding.line} ${finding.title}`);
  }
  process.exit(1);
}
console.log('Clean self-scan: 0 findings');
