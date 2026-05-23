# Adaptive Spend Firewall

Mythos Sentinel protects wallet-enabled agents before they pay x402/Base endpoints.

The important design choice is **risk-based freedom**. A strict allowlist is safe but makes agents weak. A fully open wallet is flexible but dangerous. Sentinel uses tiers:

| Tier | Default action |
| --- | --- |
| Trusted domain | Allow within budget. |
| Known service with high RouteScore | Allow within budget. |
| Unknown domain | Allow tiny trial spend only. |
| Expensive unknown domain | Require human approval. |
| Denied / very low RouteScore / over budget | Block. |

## Policy fields

```json
{
  "payments": {
    "x402": {
      "strategy": "balanced",
      "maxPerRequestUSDC": 0.25,
      "maxDailyUSDC": 5,
      "requireApprovalAboveUSDC": 0.25,
      "trustedDomains": ["api.exa.ai"],
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

## Strategies

- `balanced`: recommended default. Unknown APIs get tiny trial freedom.
- `strict`: unknown APIs require approval.
- `explorer`: for demos and experiments; keep budgets low.

## What Sentinel does not do

Sentinel does not sign transactions or claw back payments. It must sit before the wallet/payment tool. If an agent bypasses Sentinel and spends directly, Sentinel cannot protect that flow.
