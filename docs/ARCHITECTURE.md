# Architecture

Mythos Sentinel is intentionally dependency-light, local-first, and CLI/MCP-first.

## Layers

```text
CLI / MCP tools / Runtime MCP proxy / GitHub Action / Dashboard
        ↓
policy engine
        ↓
scanner · guards · RouteScore · telemetry · x402 receipts · snapshots
        ↓
JSON reports · SARIF · local receipts · local reliability signals
```

## Modules

- `src/cli.js` — command surface for scan, guard checks, RouteScore, telemetry, x402 receipts, MCP, proxy, and dashboard.
- `src/scanner` — static rules for agent skills, MCP configs, repo instructions, CI files, wallet/payment code, and unsafe commands.
- `src/core/policy.js` — policy loading and command/file/network/payment guard decisions.
- `src/core/routescore.js` — seed/custom/Bazaar service catalog, scoring, category aliases, route plans, and fallback execution primitives.
- `src/core/telemetry.js` — opt-in local telemetry store and passive reliability summaries.
- `src/core/x402-receipts.js` — sanitized x402 receipt ingestion, local receipt store, and spend summaries.
- `src/core/snapshot.js` — file hash snapshots and diffs.
- `src/core/receipt.js` — task receipts and drift verification.
- `src/mcp/server.js` — local JSON-RPC/MCP-style tool surface.
- `src/mcp/proxy.js` — runtime proxy that gates upstream MCP tools before forwarding calls.
- `src/ui/server.js` and `src/ui/static` — local dashboard and API endpoints.
- `src/report` — human, JSON, and SARIF outputs.

## Local storage

Runtime state is stored under `.mythos/`:

```text
.mythos/routescore/services.json   # imported/synced service catalog
.mythos/telemetry/events.jsonl     # opt-in local endpoint telemetry
.mythos/x402/receipts.jsonl        # sanitized x402 receipt records
.mythos/reports/                   # generated scan reports
.mythos/snapshots/                 # generated file snapshots
```

Generated runtime files should not be committed unless intentionally shared.

## Non-goals

- Not a sandbox.
- Not a wallet or transaction signer.
- Not a formal verifier.
- Not a remote SaaS scanner.
- Not a guarantee of endpoint quality or settlement success.
- Not another coding agent.

Sentinel should stay a small, auditable permission, routing, and spend-control layer around agents.
