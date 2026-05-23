# Contributing to Mythos Sentinel

Thanks for helping improve Mythos Sentinel.

Mythos Sentinel is a local-first runtime firewall for wallet-enabled agents, MCP tools, and x402/Base payment flows. Contributions should keep the project practical, secure, and easy to audit.

## Development setup

```bash
git clone https://github.com/thewaltero/mythos-sentinel.git
cd mythos-sentinel
npm ci
npm test
npm run release:check
```

For local CLI testing:

```bash
npm link
mythos-sentinel doctor
mythos-sentinel ui --host 0.0.0.0 --port 4317 --demo
```

## Before opening a pull request

Please run:

```bash
npm test
npm run release:check
```

A good pull request should include:

- a clear description of the change;
- tests for new behavior where possible;
- no secrets, wallet keys, API keys, seed phrases, telemetry logs, or local `.mythos` runtime files;
- no new dependencies unless they are necessary and explained;
- no external dashboard assets, CDNs, analytics, or tracking scripts.

## Project principles

1. **Local-first by default**  
   Do not add hosted services or data upload behavior unless it is explicit, opt-in, and documented.

2. **No wallet secrets**  
   Sentinel should not require seed phrases, private keys, wallet exports, or high-value credentials.

3. **Guardrails, not false guarantees**  
   Do not describe Sentinel as a sandbox, signer, or perfect security system. It is a policy decision engine, scanner, MCP guard/proxy, and local telemetry layer.

4. **Preserve API compatibility**  
   Dashboard changes should preserve existing local API endpoints and element IDs unless the backend is intentionally updated.

5. **Small, auditable changes**  
   Prefer focused pull requests over large rewrites.

## Areas where contributions are welcome

- runtime MCP proxy compatibility;
- x402/Base payment receipt ingestion;
- RouteScore catalog adapters;
- local telemetry and passive scoring improvements;
- scanner rules;
- docs, examples, screenshots, and demos;
- bug fixes and test coverage.

## Reporting security issues

Please do not open public issues for vulnerabilities. See [`SECURITY.md`](SECURITY.md).
