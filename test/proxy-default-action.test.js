import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateToolCall, normalizeProxyConfig } from '../src/mcp/proxy.js';
import { checkFilesystemAccess, defaultPolicy } from '../src/core/policy.js';

// ── defaultAction for unclassified tool calls ────────────────────────────────

const UNCLASSIFIABLE = {
  toolName: 'do_thing',
  // No recognized arg keys, no risky words in the name: the heuristic
  // classifier sees nothing. This is exactly the bypass shape the
  // defaultAction knob exists for.
  args: { c: 'rm -rf /' }
};

test('unclassified call is forwarded under defaultAction=allow (compat default)', () => {
  const policy = structuredClone(defaultPolicy);
  const decision = evaluateToolCall({ ...UNCLASSIFIABLE, policy });
  assert.equal(decision.decision, 'allow');
  assert.ok(decision.reasons.join(' ').includes('defaultAction=allow'));
});

test('unclassified call is blocked under defaultAction=block', () => {
  const policy = structuredClone(defaultPolicy);
  const decision = evaluateToolCall({ ...UNCLASSIFIABLE, policy, defaultAction: 'block' });
  assert.equal(decision.decision, 'block');
  assert.equal(decision.ok, false);
});

test('unclassified call requires approval under defaultAction=approval_required', () => {
  const policy = structuredClone(defaultPolicy);
  const decision = evaluateToolCall({ ...UNCLASSIFIABLE, policy, defaultAction: 'approval_required' });
  assert.equal(decision.decision, 'approval_required');
});

test('classified calls are unaffected by defaultAction', () => {
  const policy = structuredClone(defaultPolicy);
  // A recognizable, policy-clean read should still be allowed even when the
  // default for unknowns is block.
  const decision = evaluateToolCall({
    toolName: 'file_read',
    args: { path: 'src/index.js', operation: 'read' },
    policy,
    defaultAction: 'block'
  });
  assert.equal(decision.decision, 'allow');
});

test('normalizeProxyConfig validates defaultAction and falls back to allow', () => {
  assert.equal(normalizeProxyConfig({}).defaultAction, 'allow');
  assert.equal(normalizeProxyConfig({ defaultAction: 'block' }).defaultAction, 'block');
  assert.equal(normalizeProxyConfig({ defaultAction: 'approval_required' }).defaultAction, 'approval_required');
  assert.equal(normalizeProxyConfig({ defaultAction: 'yolo' }).defaultAction, 'allow');
});

// ── approvalWrite filesystem tier ────────────────────────────────────────────

test('writes to CI workflows require approval by default policy', () => {
  const policy = structuredClone(defaultPolicy);
  const decision = checkFilesystemAccess({ filePath: '.github/workflows/release.yml', operation: 'write' }, policy);
  assert.equal(decision.decision, 'approval_required');
  assert.equal(decision.ok, false);
});

test('reads of CI workflows are still allowed', () => {
  const policy = structuredClone(defaultPolicy);
  const decision = checkFilesystemAccess({ filePath: '.github/workflows/release.yml', operation: 'read' }, policy);
  assert.equal(decision.decision, 'allow');
});

test('normal source writes remain allowed and deny still wins over approval', () => {
  const policy = structuredClone(defaultPolicy);
  assert.equal(checkFilesystemAccess({ filePath: 'src/index.js', operation: 'write' }, policy).decision, 'allow');
  // A denied path that also matches an approval glob must stay blocked.
  policy.filesystem.approvalWrite = ['**/.env', ...policy.filesystem.approvalWrite];
  assert.equal(checkFilesystemAccess({ filePath: '.env', operation: 'write' }, policy).decision, 'block');
});

test('approvalWrite paths do not need to be duplicated in allowWrite', () => {
  const policy = structuredClone(defaultPolicy);
  policy.filesystem.approvalWrite = ['infra/**'];
  const decision = checkFilesystemAccess({ filePath: 'infra/main.tf', operation: 'write' }, policy);
  assert.equal(decision.decision, 'approval_required');
});
