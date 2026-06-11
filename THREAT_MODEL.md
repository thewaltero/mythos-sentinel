# Threat Model

Mythos Sentinel is a local policy and spend-control layer for agent tool use.
This document states plainly what it defends against, what it relies on, and
what it cannot do. If a claim in the README ever conflicts with this document,
this document wins.

## What Sentinel is

A local-first decision engine plus an MCP runtime proxy. It evaluates payment,
shell, file, and network intent against a policy, returns
`allow / approval_required / block`, maintains a local spend ledger, ingests
x402 receipts, and records telemetry only when explicitly enabled.

## Trust boundaries

- **The host machine is trusted.** Sentinel is not a defense against a
  compromised OS, a malicious npm dependency in *your* project, or an attacker
  with local file access. Anyone who can edit `mythos.policy.json` or the
  `.mythos/` state directory controls the firewall.
- **The agent is untrusted.** Proxy-mode decisions assume the agent may be
  prompt-injected or adversarial. This is why budget state comes from
  Sentinel's own ledger, not from the agent's self-reported totals.
- **Upstream MCP servers are semi-trusted.** Sentinel gates what is *sent* to
  them. It cannot control what a tool actually does once a call is forwarded,
  and it cannot verify that a tool's name or schema honestly describes its
  behavior.

## Tool-call classification is heuristic

`classifyToolCall` recognizes payment, command, file, and network intent from
tool names and well-known argument keys. This catches the common shapes used
by real MCP servers, but it is pattern matching, not semantics:

- A tool with an unrecognized name and opaque arguments (e.g. `do_thing` with
  `{ "c": "rm -rf /" }`) produces **no** classification.
- What happens then is governed by `mcpProxy.defaultAction`:
  - `allow` (default): the call is forwarded, annotated as unclassified.
  - `approval_required`: the call is held for a human.
  - `block`: the call is rejected.

**The default is `allow` for usability, which means classification evasion is
possible in the default configuration.** Deployments that gate real money or
sensitive filesystems should set `defaultAction` to `approval_required` or
`block`, accept the friction, and explicitly allowlist the tools they trust.
Sentinel in default configuration is a guardrail, not a security boundary.

## Spend accounting

The spend ledger (`.mythos/spend/ledger.json`) is Sentinel's source of truth
for daily budgets. Properties and limits:

- **Self-reporting can only tighten.** Enforcement uses
  `max(ledger, caller-reported)`. An agent reporting `dailySpentUSDC: 0`
  cannot reset its budget.
- **Reservation-based.** The proxy records a payment intent *before*
  forwarding it. If the upstream call fails after that, the ledger has
  over-counted. Settled x402 receipts are also recorded, so a payment observed
  on both paths may be counted twice. **Over-counting is deliberate: every
  accounting error in Sentinel tightens budgets; none loosens them.**
- **Blind spots.** Payments that bypass the proxy *and* never produce an
  ingested receipt are invisible. An agent with direct wallet access outside
  the proxied tools is outside Sentinel's reach. Sentinel limits what flows
  through it; it is not wallet custody and does not replace wallet-level
  spending caps.
- **Corruption fails toward zero.** An unreadable ledger is treated as empty
  (and flagged). The `max()` rule means an honest agent's self-reports still
  bind in that window, but a corrupted ledger plus a dishonest agent means
  budget state is lost until receipts repopulate it. The write path is atomic
  (temp file + rename) to make corruption unlikely.
- **Per-request caps never depend on the ledger** and bind regardless of the
  above.

## Command, file, and network checks

- Command screening is regex-based blocklisting of known-dangerous shapes
  (pipe-to-shell, recursive deletes, encoded PowerShell). Blocklists are
  bypassable by construction; treat them as friction plus audit, not as a
  sandbox. Sentinel does not execute or sandbox commands itself.
- Filesystem policy is glob-based with three tiers: `deny` (always), then
  `approvalWrite` (human in the loop — CI workflow files by default, since a
  workflow write is code execution with the repo's CI credentials), then
  `allowWrite` / `allowRead`. Deny always wins over approval.
- Network checks act on the domain Sentinel can extract from the call. They
  do not inspect traffic and cannot see requests a forwarded tool makes
  internally.

## Receipts and snapshots

Workspace receipts hash before/after state and verify that claimed work
matches the disk. They prove *what changed*, not *why*, and they do not cover
changes made outside the workspace root.

## Signed spend mandates

A mandate is an EIP-712 signature over scope, caps, and validity window. The
signature proves *the holder of that key authorized this spending envelope* —
nothing more. Enforcement remains local: an attacker with host access can
delete the mandate check along with everything else (see "Trust boundaries").
A corrupted or tampered mandate file fails verification and simply stops
granting authority — mandates can only be removed by tampering, never widened.
Private keys are read from environment variables, used in-memory, and never
written to disk by Sentinel. Use a dedicated key for mandates; it does not
need to hold funds.

## On-chain attestation

An attestation commits the hashes of local records (x402 receipts, ledger
days, included receipt files) to Base via EAS. It proves that *these exact
records existed and were committed to, at this time, by this key*. It is
tamper-evidence and timestamping. It is **not** proof that the recorded work
or payments were themselves truthful — a dishonest local record attests
dishonestly. The value is bilateral: once attested, records cannot be quietly
rewritten later. Broadcast requires an explicitly funded key in an env var
(`SENTINEL_ATTEST_KEY`); use a dedicated low-value key, and test on
base-sepolia before mainnet. Everything except broadcast is offline.

## Directory publishing

`directory build` is a manual, opt-in export. It aggregates to domain level
only: counts, settle/fail rates, summed volume, day-precision first/last seen.
No endpoints, paths, query strings, request ids, transaction hashes, or
per-request amounts are included, and domains under the --min-receipts
threshold are excluded. Sentinel never uploads the result anywhere; publishing
is a deliberate human act. Review the output before sharing — aggregate spend
volume per domain is itself information you may not want public.

## Telemetry

Off by default. When enabled, events are sanitized locally (no prompts,
responses, secrets, private file contents, or wallet balances) and stored
under `.mythos/telemetry` on the local machine only.

## Reporting

Security issues: see SECURITY.md. Claims in marketing or docs that exceed
this threat model are bugs — please report them too.
