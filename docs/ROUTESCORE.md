# RouteScore

RouteScore is the reliability, recommendation, and fallback-routing layer inside Mythos Sentinel.

It is not a fake global oracle. It starts with a seed catalog, can import live/custom services, and becomes more valuable when agents route calls through Sentinel and opt into local telemetry.

## Data layers

1. **Seed metadata**: category, domain, endpoint, rough price, network, notes.
2. **Custom local services**: user-provided JSON/YAML catalogs stored in `.mythos/routescore/services.json`.
3. **Bazaar discovery**: optional sync from CDP Bazaar discovery endpoints.
4. **Free checks**: domain alive, x402 quote/402 response, price metadata, schema shape, quote latency.
5. **Passive routed-call telemetry**: local success/failure, latency, schema match, price mismatch from proxied calls.
6. **x402 receipts**: optional local payment/settlement proof ingestion.
7. **Fallback routing**: selected route plus ordered fallback candidates.
8. **Small paid probes**: optional checks for important endpoints later.

Sentinel must never collect prompts, full responses, secrets, private keys, wallet balances, or user files as RouteScore telemetry. The current implementation is local-only and disabled by default.

## CLI

```bash
mythos-sentinel routescore list
mythos-sentinel routescore recommend --category web_search --max-price 0.05
mythos-sentinel routescore categories
mythos-sentinel routescore route --category web_search --max-price 0.05
mythos-sentinel routescore fallback --category web_search --max-price 0.05 --simulate-fail primary
```

## Import custom services

Create `services.yml`:

```yaml
services:
  - name: Custom Search API
    category: web_search
    domain: api.example.com
    endpoint: https://api.example.com/search
    priceUSDC: 0.01
    network: base
    tags:
      - search
      - custom
```

Import it:

```bash
mythos-sentinel routescore import services.yml
mythos-sentinel routescore list
```

Custom services are stored locally in `.mythos/routescore/services.json`.

## Sync Bazaar discovery

```bash
# Browse the paginated x402 catalog and save normalized services locally.
mythos-sentinel routescore sync-bazaar --limit 100

# Search the catalog and save only matching services.
mythos-sentinel routescore sync-bazaar --query web_search --limit 20

# Search without saving.
mythos-sentinel routescore search-bazaar --query browser --limit 10
```

Network calls are only made when you run `sync-bazaar` or `search-bazaar`. Normal RouteScore operations stay local.

## MCP tools

- `sentinel_recommend_x402_service`
- `sentinel_route_x402_service`
- `sentinel_score_x402_domain`

## Why routing matters

Agents should not need to manually choose between dozens of paid APIs. RouteScore can give an agent a route plan:

1. selected service
2. fallback services
3. price and score
4. Sentinel payment-policy decision

The route plan is not a guarantee of output quality. It is a pre-spend reliability and policy signal.

## Telemetry commands

```bash
mythos-sentinel telemetry enable
mythos-sentinel telemetry status
mythos-sentinel telemetry summary
```

See `docs/TELEMETRY.md` and `docs/PASSIVE_SCORING.md`.

## Related docs

- `docs/FALLBACK_ROUTING.md`
- `docs/X402_RECEIPTS.md`
