<div align="center">
  <img src="assets/banner.png" alt="Mythos Sentinel banner" width="864" />
</div>

# Mythos Sentinel

**Local-first runtime firewall for wallet-enabled AI agents, MCP tools, and x402/Base payments.**

Agents are starting to discover paid APIs and pay over HTTP. Sentinel sits before those payments and answers the question raw wallets and discovery layers do not fully answer:

> Should this agent be allowed to spend this amount on this endpoint right now?

```text
Agent / MCP client / wallet-enabled workflow
        ↓
Mythos Sentinel
        ↓
policy · budget · unknown-domain rules · RouteScore signal
        ↓
allow · approval_required · block · receipt
```

## Why Sentinel?

| Tool type | What it does | What Sentinel adds |
| --- | --- | --- |
| Agent frameworks | Run tasks and call tools | Spend/control layer before risky actions |
| MCP clients | Connect agents to tools | Runtime proxy and policy enforcement |
| x402 APIs | Let agents pay services | Budget, trust, receipts, and fallback routing |
| Wallet permissions | Limit raw spend | Context-aware allow / approval / block decisions |
| API marketplaces | Help agents discover services | Local reliability scoring and routing decisions |

## What changed in v0.10

Sentinel now has **x402 receipt ingestion**, **fallback routing primitives**, and a broader service-category model. v0.9 added custom/Bazaar service imports and route plans; v0.10 attaches payment proof, summarizes observed x402 spend, and gives agents a structured fallback execution path instead of a single brittle endpoint choice.

Sentinel is no longer just a static allowlist guard. It now has an **adaptive payment model**:

- trusted domains auto-allow within budget;
- known services can be auto-allowed when RouteScore is high;
- unknown x402 domains get tiny trial payments instead of being blocked by default;
- expensive or low-score calls require approval;
- denied domains and very low-score calls block;
- RouteScore starts with a seed catalog, then learns from imports, optional Bazaar metadata, telemetry, and receipts;
- telemetry is opt-in and stores sanitized endpoint metadata only;
- `routescore route` and `sentinel_route_x402_service` return selected services plus fallback plans;
- `routescore fallback` simulates/validates fallback attempts without spending;
- `x402-receipt ingest` stores sanitized payment proof locally and can feed telemetry.

## Why this exists

x402/Bazaar-style discovery makes it easier for agents to find and pay APIs. That creates a new problem: agents can spend quickly, but they still need budgets, trust signals, logs, and approval rules.

Sentinel is the local control layer around that behavior:

- Can this agent spend on this domain?
- Is this amount safe for an unknown API?
- Does RouteScore say this endpoint is reliable enough?
- Did the action produce an audit trail?
- Should the human approve before payment?

## Core features

| Feature | What it does |
| --- | --- |
| Adaptive x402/Base spend guard | Enforces trusted, known, unknown, denied, budget, and RouteScore-based decisions. |
| RouteScore catalog + routing | Scores seed, custom, and Bazaar-imported paid agent APIs, then recommends selected services and fallback routes. |
| Fallback routing primitives | Plans and executes fallback attempts through caller-provided executors so agents can retry safer alternatives when a provider fails. |
| x402 receipt ingestion | Normalizes sanitized x402 payment receipts, tracks settlement status, and summarizes observed spend without storing prompts or responses. |
| Opt-in local telemetry | Stores sanitized local endpoint events only after the user enables it. No prompts, responses, secrets, private files, or wallet balances. |
| Passive reliability scoring | Uses proxied-call success/failure, latency, schema, and price-match signals to improve RouteScore locally. |
| Runtime MCP proxy | Puts Sentinel in front of upstream MCP tools so risky calls cannot bypass policy. |
| Scanner and guards | Finds risky instructions and checks command, file, network, and payment actions before execution. |
| Receipts | Captures before/after workspace hashes and verifies agent work. |
| Local dashboard | A premium local control room for policy, RouteScore, telemetry, receipts, and guard tests. |
| GitHub Action | Runs Sentinel in CI without model keys, wallet keys, or hosted accounts. |

## Install

```bash
npm install -g mythos-sentinel
```

Or run directly:

```bash
npx mythos-sentinel help
```

Node.js 20+ is required. Sentinel does **not** require OpenAI, Anthropic, Coinbase, wallet, or private-key access.

## Runtime MCP proxy

Direct MCP mode gives agents Sentinel tools to ask for permission. Runtime proxy mode puts Sentinel in front of upstream MCP servers so risky calls cannot bypass policy.

```bash
mythos-sentinel proxy
```

Flow:

```txt
Agent -> Mythos Sentinel Proxy -> upstream MCP tools / x402 APIs
```

Use this mode for wallet-enabled agents, paid x402 APIs, shell tools, file tools, browser tools, and demos that need real enforcement. See `docs/RUNTIME_MCP_PROXY.md`.

## Quick start

Inside the project you want to protect:

```bash
mythos-sentinel init --base
mythos-sentinel scan .
mythos-sentinel ui
```

Check actions before an agent does them:

```bash
mythos-sentinel check-command -- "npm install unknown-package"
mythos-sentinel check-file --path .env --operation read
mythos-sentinel check-network --domain api.github.com
mythos-sentinel check-payment --domain api.exa.ai --amount 0.01
mythos-sentinel check-payment --domain fresh-api.example --amount 0.01
mythos-sentinel check-payment --domain fresh-api.example --amount 0.10
```

List, import, recommend, and route x402 services:

```bash
mythos-sentinel routescore categories
mythos-sentinel routescore list
mythos-sentinel routescore import services.yml
mythos-sentinel routescore sync-bazaar --query web_search --limit 20
mythos-sentinel routescore recommend --category web_search --max-price 0.05
mythos-sentinel routescore route --category web_search --max-price 0.05
mythos-sentinel routescore fallback --category web_search --max-price 0.05 --simulate-fail primary
```

Enable local telemetry and inspect receipt summaries:

```bash
mythos-sentinel telemetry enable
mythos-sentinel telemetry status
mythos-sentinel telemetry summary
mythos-sentinel x402-receipt summary
```

## Adaptive payment policy

Default behavior is balanced: agents can explore, but not with unlimited wallet freedom.

```json
{
  "payments": {
    "x402": {
      "enabled": true,
      "strategy": "balanced",
      "maxPerRequestUSDC": 0.25,
      "maxDailyUSDC": 5,
      "requireApprovalAboveUSDC": 0.25,
      "trustedDomains": ["api.coinbase.com", "api.developer.coinbase.com", "api.exa.ai"],
      "deniedDomains": [],
      "unknown": {
        "allowTrial": true,
        "maxPerRequestUSDC": 0.02,
        "maxDailyUSDC": 0.25,
        "requireApprovalAboveUSDC": 0.02
      },
      "routeScore": {
        "autoAllowMinScore": 80,
        "requireApprovalBelowScore": 60,
        "blockBelowScore": 35
      }
    }
  }
}
```

Decision model:

```text
trusted domain + under budget         -> allow
known service + high RouteScore       -> allow
unknown domain + tiny amount          -> allow trial
unknown domain + larger amount        -> approval_required
low RouteScore / denied / over budget -> block
```

This avoids the bad tradeoff of either blocking every new API or letting agents freely spend on anything.

## RouteScore and fallback routing

RouteScore is **not** a fake global oracle. It starts with a seed catalog, can import live/custom services, and becomes more valuable when agents route calls through Sentinel and opt into local telemetry.

Data layers:

1. **Seed metadata** — starter category/domain/endpoint/rough-price metadata.
2. **Custom local services** — user-imported `services.yml` / JSON.
3. **Optional Bazaar metadata** — live public discovery metadata synced into local storage.
4. **Local telemetry** — opt-in success/failure/latency/price-match observations.
5. **x402 receipts** — sanitized local payment/settlement records.

Commands:

```bash
mythos-sentinel routescore categories
mythos-sentinel routescore list --json
mythos-sentinel routescore import services.yml
mythos-sentinel routescore sync-bazaar --query content_extraction --limit 20
mythos-sentinel routescore recommend --category content_extraction --max-price 0.05 --json
mythos-sentinel routescore route --category content_extraction --max-price 0.05 --json
mythos-sentinel routescore fallback --category content_extraction --max-price 0.05 --simulate-fail primary
```

Custom service catalog example:

```yaml
services:
  - name: Custom Search API
    category: web_search
    domain: api.example.com
    endpoint: https://api.example.com/search
    priceUSDC: 0.01
    network: base
```

See `docs/ROUTESCORE.md`, `docs/FALLBACK_ROUTING.md`, and `docs/BAZAAR_ADAPTER.md`.

## Opt-in telemetry and x402 receipts

Telemetry is disabled until the user enables it. It stores sanitized endpoint metadata only and never stores prompts, responses, secrets, private files, private keys, or wallet balances.

```bash
mythos-sentinel telemetry enable
mythos-sentinel telemetry status
mythos-sentinel telemetry summary
mythos-sentinel telemetry events --json
```

x402 receipt ingestion stores sanitized payment proof locally and can feed RouteScore telemetry when telemetry is enabled.

```bash
mythos-sentinel x402-receipt ingest --file receipt.json
mythos-sentinel x402-receipt summary
mythos-sentinel x402-receipt list --json
```

See `docs/TELEMETRY.md`, `docs/PASSIVE_SCORING.md`, and `docs/X402_RECEIPTS.md`.

## Local dashboard

Run:

```bash
mythos-sentinel ui
```

For GitHub Codespaces demos:

```bash
mythos-sentinel ui --host 0.0.0.0 --port 4317 --demo
```

The dashboard is local-first. It does not upload repos, secrets, wallet keys, prompts, responses, telemetry, or reports to a hosted Mythos service.

## MCP usage

Run the MCP-style server:

```bash
mythos-sentinel mcp
```

Example Cursor/Claude MCP config:

```json
{
  "mcpServers": {
    "mythos-sentinel": {
      "command": "npx",
      "args": ["mythos-sentinel", "mcp"]
    }
  }
}
```

Exposed tools:

- `sentinel_scan_path`
- `sentinel_check_x402_payment`
- `sentinel_recommend_x402_service`
- `sentinel_route_x402_service`
- `sentinel_list_service_categories`
- `sentinel_parse_x402_receipt`
- `sentinel_score_x402_domain`
- `sentinel_check_command`
- `sentinel_check_file`
- `sentinel_check_network`
- `sentinel_snapshot`

## Scanner demo

Sentinel detects secrets, risky shell installers, sensitive files, network calls, and policy violations before agent work is trusted.

## Receipts

Create an agent work receipt:

```bash
mythos-sentinel snapshot . --out .mythos/snapshots/before.json
# Let Codex/Cursor/Claude/your agent work here.
mythos-sentinel scan . --out .mythos/reports/sentinel-report.json
mythos-sentinel receipt \
  --before .mythos/snapshots/before.json \
  --summary "Implemented feature safely" \
  --agent codex \
  --provider openai \
  --tool codex-cli \
  --out mythos-receipt.json
mythos-sentinel verify --receipt mythos-receipt.json
```

## CLI commands

```text
mythos-sentinel init [--base] [--force]
mythos-sentinel scan [path] [--json] [--sarif] [--out report.json] [--fail-on high|critical|none]
mythos-sentinel check-payment --domain api.example.com --amount 0.05 [--daily-spent 1.2] [--route-score 91]
mythos-sentinel check-command -- "shell command"
mythos-sentinel check-file --path .env --operation read|write
mythos-sentinel check-network --domain api.example.com
mythos-sentinel routescore list|categories|recommend|route|fallback [--category web_search] [--max-price 0.05]
mythos-sentinel routescore import services.yml
mythos-sentinel routescore sync-bazaar [--query web_search] [--limit 20]
mythos-sentinel routescore search-bazaar --query browser --limit 10
mythos-sentinel telemetry status|enable|disable|summary|events
mythos-sentinel x402-receipt ingest --file receipt.json
mythos-sentinel x402-receipt summary
mythos-sentinel x402-receipt list
mythos-sentinel snapshot [path] --out before.json
mythos-sentinel receipt --before before.json --summary "task" --agent codex
mythos-sentinel verify --receipt mythos-receipt.json
mythos-sentinel mcp
mythos-sentinel proxy [--policy mythos.policy.json] [--config proxy.json]
mythos-sentinel ui [--host 127.0.0.1] [--port 4317] [--open] [--demo]
mythos-sentinel doctor
```

## Security model

Sentinel is a policy decision engine and scanner. It is **not** a sandbox, wallet, transaction signer, or guarantee of API quality. It works when agents route risky actions through Sentinel before execution/payment.

For real funds, use least-privilege agent wallets, low spend permissions, testnet rehearsals, separate API credentials, hardware wallets for high-value assets, and human approval for large payments.

## Roadmap

- [x] Static agent/skill/MCP/repo scanner
- [x] command, file, network, and x402/Base guards
- [x] adaptive unknown-domain trial policy
- [x] RouteScore seed catalog and recommendation API
- [x] MCP RouteScore tools
- [x] premium local dashboard
- [x] GitHub Action and optional SARIF workflow
- [x] snapshot and agent work receipts
- [x] runtime MCP proxy mode
- [x] opt-in local telemetry store
- [x] passive routed-call reliability scoring
- [x] live Bazaar catalog adapter
- [x] fallback route planning and execution primitives
- [x] expanded service categories
- [x] x402 payment receipt ingestion
- [ ] signed provider badges
- [ ] optional shared reliability network

## License

MIT
