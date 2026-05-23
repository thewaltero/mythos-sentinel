#!/usr/bin/env bash
set -euo pipefail

npm test
node ./bin/mythos-sentinel.js doctor
node ./bin/mythos-sentinel.js check-command -- "npm test"
node ./bin/mythos-sentinel.js check-file --path src/index.js --operation write
node ./bin/mythos-sentinel.js check-network --domain api.github.com
node ./bin/mythos-sentinel.js check-payment --domain api.coinbase.com --amount 0.05
mkdir -p .mythos/reports
node ./bin/mythos-sentinel.js scan . --json --out .mythos/reports/release-self-scan.json --fail-on none
node ./bin/mythos-sentinel.js scan . --sarif --out .mythos/reports/release-self-scan.sarif --fail-on none
node ./scripts/verify-clean-self-scan.js
node ./scripts/verify-ui-server.js
npm pack --dry-run
