# On-chain features: mandates, attestation, directory

All three features are local-first. Nothing touches a network or chain
without an explicit `--broadcast` flag, and all key material comes from
environment variables, used in-memory only. Read THREAT_MODEL.md first —
it states precisely what each proof does and does not establish.

## Signed spend mandates

```bash
export SENTINEL_MANDATE_KEY=0x...   # dedicated key; does not need funds
mythos-sentinel mandate create --cap 5 --max-per-request 0.25 \
  --domains api.example.com,*.trusted.io --days 7
mythos-sentinel mandate list
mythos-sentinel mandate verify --file .mythos/mandates/<id>.json --domain api.example.com --amount 0.1
```

Set `"payments": { "x402": { "requireMandate": true } }` in your policy and
the proxy holds any payment not covered by a valid mandate for approval.
Every covered payment is recorded in the ledger against its mandate id, so
`mandate list` shows lifetime spend vs. cap per mandate.

## Receipt attestation (EAS on Base)

```bash
mythos-sentinel attest                          # dry-run bundle, offline
mythos-sentinel attest --sign                   # + offline EIP-712 signature
mythos-sentinel attest verify --file .mythos/attestations/<file>.json
mythos-sentinel attest --include mythos-receipt.json --include path/to/router-receipt.json --sign

# One-time per network, then put the printed UID in policy.attestation.schemaUid:
export SENTINEL_ATTEST_KEY=0x...                # funded, dedicated, low-value
mythos-sentinel attest schema --broadcast --network base-sepolia

# On-chain attestation (ALWAYS test on base-sepolia first):
mythos-sentinel attest --sign --broadcast --network base-sepolia
```

The bundle commits to x402 receipts, the day's spend ledger, every work
receipt found in `.mythos/receipts/` (the shared stack convention —
mythos-router writes its SWD receipts there, so router + sentinel sessions
attest together with no flags), and any `--include` files via a sorted-leaf
merkle root; `bundleHash` covers an
explicit committed payload, so the stored file can carry the signature and
tx info without breaking verification.

## x402 service directory

```bash
mythos-sentinel directory build --min-receipts 3
# review .mythos/directory/DIRECTORY.md, then commit/host it if you choose
```

Domain-level aggregates only; see THREAT_MODEL.md "Directory publishing"
for the sanitization rules.
