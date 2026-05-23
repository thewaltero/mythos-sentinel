# Bazaar Adapter

Mythos Sentinel v0.10 can import x402 service metadata from CDP Bazaar discovery endpoints into the local RouteScore catalog.

## Why it exists

The seed RouteScore catalog is intentionally small. The Bazaar adapter lets Sentinel expand from a few seed services into a live/local catalog without manually hardcoding every endpoint.

## Commands

```bash
mythos-sentinel routescore sync-bazaar --limit 100
mythos-sentinel routescore sync-bazaar --query web_search --limit 20
mythos-sentinel routescore search-bazaar --query browser --limit 10
```

Synced services are normalized and stored in:

```text
.mythos/routescore/services.json
```

## What is normalized

- `resource` / endpoint URL
- domain
- inferred category
- network
- rough USDC price when payment metadata exposes an amount
- metadata description
- input/output schema presence
- payment metadata presence
- last updated timestamp

## Privacy

The adapter fetches public catalog metadata only. It does not send prompts, responses, wallet keys, private files, or telemetry to Mythos.

## Reliability model

Bazaar metadata expands discovery. Passive telemetry and RouteScore scoring still decide whether a service is preferred, limited, trial-only, or avoided.
