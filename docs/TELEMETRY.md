# Opt-in Local Telemetry

Mythos Sentinel can store a small local telemetry log so RouteScore can learn from real routed calls without Mythos paying for every API probe.

Telemetry is **disabled by default**.

Enable it:

```bash
mythos-sentinel telemetry enable
```

Disable it:

```bash
mythos-sentinel telemetry disable
```

View status and summary:

```bash
mythos-sentinel telemetry status
mythos-sentinel telemetry summary
mythos-sentinel telemetry events --json
```

## What is stored

Events are written locally to:

```text
.mythos/telemetry/events.jsonl
```

Each event contains only sanitized reliability metadata:

- endpoint domain
- service id when matched to the RouteScore catalog
- decision: allow, block, approval_required, upstream_error
- amount in USDC when present
- latency in milliseconds
- success/failure status
- schema/price-match flags when known
- timestamp
- upstream/tool names

## What is never stored

Sentinel does not store:

- prompts
- model responses
- secrets
- private file contents
- wallet balances
- seed phrases or private keys

## Passive routed-call reliability scoring

When telemetry is enabled and an agent uses `mythos-sentinel proxy`, Sentinel observes whether forwarded paid/network API calls succeeded or failed. Those events feed RouteScore automatically:

```text
Agent -> Sentinel Proxy -> x402/API tool
              ↓
     local telemetry event
              ↓
     RouteScore success rate / latency / failure count
```

This means users or agents pay for their own API calls, while Sentinel learns from the result locally.

## Local-first by design

The current implementation is local-only. It does not upload telemetry to a hosted Mythos service. A future shared reliability network should stay explicit opt-in and anonymous.
