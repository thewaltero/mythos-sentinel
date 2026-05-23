# Security Policy

Mythos Sentinel is security-sensitive software. Please report vulnerabilities responsibly.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest release | ✅ |
| Older releases | Best effort |

## Reporting a vulnerability

Please report security issues using GitHub's private vulnerability reporting / Security Advisory flow for this repository.

If private vulnerability reporting is not enabled yet, open a minimal public issue that says:

> Security report available — please enable private vulnerability reporting.

Do **not** include exploit details, private keys, secrets, wallet data, or working attack payloads in a public issue.

## What to include

When reporting privately, include:

- affected version or commit;
- operating system and Node.js version;
- clear reproduction steps;
- expected behavior vs actual behavior;
- potential impact;
- suggested fix if you have one.

## Scope

Security reports are especially valuable for:

- bypassing command, file, network, payment, or MCP proxy policy checks;
- leaking prompts, responses, wallet data, secrets, private files, or telemetry data;
- unsafe handling of x402/Base payment metadata;
- incorrect allow / approval_required / block decisions;
- dashboard XSS or local API abuse;
- unsafe dependency, packaging, or CI behavior.

## Out of scope

The following are usually out of scope unless they lead to a real exploit:

- attacks requiring the user to paste a seed phrase or private key;
- issues in third-party MCP servers or APIs that Sentinel does not control;
- theoretical vulnerabilities without a realistic reproduction;
- social engineering unrelated to Sentinel.

## Safety boundaries

Mythos Sentinel is not a sandbox, wallet, signer, or guarantee of API quality. It works when agents route risky actions through Sentinel before execution or payment. For real funds, use least-privilege agent wallets, low spend limits, testnet rehearsals, and human approval for large payments.
