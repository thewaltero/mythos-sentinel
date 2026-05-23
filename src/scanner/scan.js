import fs from 'node:fs/promises';
import path from 'node:path';
import { walkFiles, readTextMaybe, sha256File } from '../core/fs.js';
import { matchesAnyGlob } from '../core/path-utils.js';
import { CONTENT_RULES, PATH_RULES } from './rules.js';
import { VERSION } from '../version.js';
import { evaluateFindings } from '../core/policy.js';

export async function scanPath(targetPath = '.', options = {}) {
  const root = path.resolve(targetPath);
  const policy = options.policy || {};
  const startedAt = new Date().toISOString();
  const ignore = [
    ...(policy.scanner?.ignore || []),
    ...(await readMythosIgnore(root)),
    ...(options.ignore || [])
  ];
  const files = await walkFiles(root, { ignore });
  const findings = [];
  const scannedFiles = [];
  const skippedFiles = [];

  for (const file of files) {
    const rel = file.rel;
    for (const rule of PATH_RULES) {
      if (rule.pattern.test(rel)) findings.push(makeFinding(rule, rel, 1, rel));
    }

    if (matchesAnyGlob(rel, policy.filesystem?.deny || [])) {
      findings.push({
        id: 'MS-POLICY-FS-DENY',
        title: 'File path violates Sentinel filesystem deny policy',
        severity: 'high',
        category: 'policy',
        file: rel,
        line: 1,
        evidence: rel,
        recommendation: 'Move this file outside the agent workspace or update policy deliberately.',
        confidence: 'high',
        tags: ['policy', 'filesystem']
      });
    }

    const read = await readTextMaybe(file.absPath, options.maxBytes || 512 * 1024);
    if (read.skipped) {
      skippedFiles.push({ file: rel, reason: read.reason });
      continue;
    }
    scannedFiles.push({ file: rel, bytes: read.size, sha256: await sha256File(file.absPath) });
    findings.push(...scanText(rel, read.text));
  }

  const summary = evaluateFindings(findings, policy, options.failOn);
  return {
    schema: 'https://mythos.dev/schemas/sentinel-report.v0.json',
    tool: { name: 'mythos-sentinel', version: VERSION },
    target: root,
    startedAt,
    completedAt: new Date().toISOString(),
    summary,
    files: { total: files.length, scanned: scannedFiles.length, skipped: skippedFiles.length },
    scannedFiles,
    skippedFiles,
    findings
  };
}

export function scanText(file, text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (const rule of CONTENT_RULES) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (rule.pattern.test(line)) {
        findings.push(makeFinding(rule, file, i + 1, redactEvidence(line.trim())));
      }
    }
  }
  return findings;
}

function makeFinding(rule, file, line, evidence) {
  return {
    id: rule.id,
    title: rule.title,
    severity: rule.severity,
    category: rule.category,
    file,
    line,
    evidence,
    recommendation: rule.recommendation,
    confidence: 'medium',
    tags: rule.tags || []
  };
}

function redactEvidence(value) {
  if (!value) return value;
  let evidence = value;
  evidence = evidence.replace(/(PRIVATE_KEY|MNEMONIC|SEED_PHRASE|API_KEY|TOKEN|SECRET)(\s*[:=]\s*)['\"]?[^\s'\"]+/ig, '$1$2[REDACTED]');
  if (evidence.length > 220) evidence = `${evidence.slice(0, 217)}...`;
  return evidence;
}


async function readMythosIgnore(root) {
  const ignorePath = path.join(root, '.mythosignore');
  try {
    const raw = await fs.readFile(ignorePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}
