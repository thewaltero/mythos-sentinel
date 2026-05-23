# x402 receipt ingestion

Sentinel can ingest sanitized x402 payment receipts and settlement responses so agent payment events become auditable without storing prompts, responses, private request bodies, secrets, private keys, or wallet balances.

## Commands

```bash
mythos-sentinel x402-receipt ingest --file receipt.json
mythos-sentinel x402-receipt summary
mythos-sentinel x402-receipt list --json
```

Receipts are stored locally at:

```txt
.mythos/x402/receipts.jsonl
```

This path is ignored by Git by default.

## Accepted input shapes

The ingester accepts common receipt/settlement shapes and tries to normalize them:

```json
{
  "endpoint": "https://api.exa.ai/search",
  "amount": "5000",
  "asset": "USDC",
  "network": "eip155:8453",
  "status": "settled",
  "txHash": "0x..."
}
```

It also accepts payment-response header style values through keys like `x-payment-response`, `x-payment`, `x402-receipt`, or `x402-payment-response` when provided as JSON/base64 JSON.

## Stored fields

Sentinel stores only sanitized payment metadata:

- domain and endpoint
- amount, asset, network
- payer/payTo when present
- transaction hash when present
- settlement status
- facilitator when present
- observed timestamp

It does not store prompts, responses, private request bodies, secrets, private files, private keys, or wallet balances.

## Telemetry integration

When opt-in telemetry is enabled, ingested receipts also produce sanitized local telemetry events. Settled receipts count as successful payment observations; failed receipts count as failures.
