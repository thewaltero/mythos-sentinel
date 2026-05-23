# Mythos Sentinel rules for Codex

Codex may edit project files, but all agent work must pass Mythos Sentinel policy checks.

## Required workflow

1. Before editing, run:
   `mythos-sentinel snapshot . --out .mythos/snapshots/before.json`
2. Before risky actions, ask Sentinel:
   - command: `mythos-sentinel check-command -- "<command>"`
   - file write: `mythos-sentinel check-file --path <path> --operation write`
   - network: `mythos-sentinel check-network --domain <domain>`
   - RouteScore: `mythos-sentinel routescore recommend --category <category> --max-price <usdc>`
   - x402/Base spend: `mythos-sentinel check-payment --domain <domain> --amount <usdc> [--route-score <score>]`
3. Make the requested changes.
4. Run tests/lint for the project.
5. Run:
   `mythos-sentinel scan . --out .mythos/reports/sentinel-report.json`
6. Create a receipt:
   `mythos-sentinel receipt --before .mythos/snapshots/before.json --summary "<task>" --agent codex --provider openai --tool codex-cli --out mythos-receipt.json`

## Never do this

- Never read `.env`, private keys, wallet secrets, SSH keys, browser profiles, or unrelated home-directory files.
- Never make x402/Base/USDC payments unless Sentinel returns `allow`. Unknown domains may only use tiny trial payments under policy; larger payments require human approval.
- Never install unknown agent skills or MCP servers without scanning them first.
- Never run destructive shell commands.

## Hard stop

Stop and ask for approval if Sentinel returns `block` or `approval_required`.
