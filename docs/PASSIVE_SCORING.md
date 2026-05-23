# Passive Routed-Call Reliability Scoring

Passive scoring lets RouteScore improve from actual proxy traffic instead of requiring Mythos to spend money probing every endpoint.

## Flow

```text
1. Agent calls a tool through Mythos Sentinel Proxy.
2. Sentinel classifies the call as payment/network/shell/file.
3. If allowed, Sentinel forwards it to the upstream MCP server.
4. Sentinel records sanitized local metadata about success/failure and latency.
5. RouteScore uses the telemetry summary when ranking services.
```

## What improves the score

- high success rate
- valid schema signal
- low median latency
- price matching the quote
- more passive samples

## What lowers the score

- upstream failures
- repeated recent failures
- price mismatch
- poor schema match
- high latency

## No paid probes required

The first implementation does not require Sentinel to pay for APIs. It uses the user or agent's own routed calls. Active paid probes can be added later for important endpoints, but they are not required for the public MVP.
