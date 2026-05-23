import { SEVERITY_ORDER } from '../core/policy.js';

const SYMBOLS = {
  info: 'ℹ',
  low: '◦',
  medium: '▲',
  high: '◆',
  critical: '✖'
};

export function formatScanReport(report) {
  const { summary, files, findings } = report;
  const lines = [];
  lines.push('');
  lines.push('Mythos Sentinel Report');
  lines.push('======================');
  lines.push(`Target: ${report.target}`);
  lines.push(`Files: ${files.scanned}/${files.total} scanned, ${files.skipped} skipped`);
  lines.push(`Findings: ${summary.findingCount} | Highest: ${summary.highestSeverity.toUpperCase()} | Status: ${summary.ok ? 'PASS' : 'FAIL'}`);
  if (!findings.length) {
    lines.push('');
    lines.push('No findings.');
    return lines.join('\n');
  }
  lines.push('');
  for (const finding of sortFindings(findings)) {
    lines.push(`${SYMBOLS[finding.severity] || '!'} [${finding.severity.toUpperCase()}] ${finding.id} ${finding.title}`);
    lines.push(`  ${finding.file}:${finding.line}`);
    if (finding.evidence) lines.push(`  evidence: ${finding.evidence}`);
    lines.push(`  fix: ${finding.recommendation}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function formatPaymentDecision(decision) {
  const lines = [];
  lines.push(`Decision: ${decision.decision.toUpperCase()} ${decision.ok ? '✅' : '⛔'}`);
  if (decision.subject) lines.push(`Subject: ${decision.subject}`);
  if (decision.trustTier) lines.push(`Trust: ${decision.trustTier}`);
  if (decision.amountUSDC !== undefined) lines.push(`Amount: ${decision.amountUSDC} USDC`);
  if (decision.routeScore !== undefined && decision.routeScore !== null) lines.push(`RouteScore: ${decision.routeScore}/100`);
  for (const reason of decision.reasons || []) lines.push(`- ${reason}`);
  return lines.join('\n');
}

function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const s = SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity);
    if (s) return s;
    return `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`);
  });
}
