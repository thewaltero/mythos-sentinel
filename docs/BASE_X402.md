# Base / x402 Positioning

Mythos Sentinel is built for agents that can discover paid services and pay over x402/Base.

The product should be positioned as:

> Adaptive spend firewall and RouteScore reliability layer for wallet-enabled agents.

Not as:

- a wallet
- a transaction signer
- a generic MCP scanner only
- a fake API marketplace
- a guarantee of endpoint quality

## Correct flow

```text
Agent discovers paid API
        ↓
RouteScore recommends/checks reliability
        ↓
Sentinel checks policy, budget, trust, and score
        ↓
allow / approval_required / block
        ↓
payment tool or wallet executes only if allowed
```

## Why this is useful

x402 reduces friction for paid APIs. That makes the next problem obvious: agents need spend limits, endpoint trust, routing context, and receipts. Sentinel focuses on that runtime gap.
