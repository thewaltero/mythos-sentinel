# Threat model

Mythos Sentinel focuses on risks created when AI agents can install tools, read files, run commands, call APIs, and spend money.

## In scope

- malicious or compromised agent skills
- prompt injection inside skill instructions
- MCP tool poisoning or unsafe tool descriptions
- local secret exposure
- wallet/private-key exposure
- unauthorized x402/Base spending
- dangerous shell commands
- CI permission escalation
- auditability of AI-generated work

## Out of scope for v0.1

- full OS sandboxing
- malware reverse engineering
- formal verification
- blockchain transaction settlement
- real-time network proxying
- guaranteed prompt-injection prevention

## Security stance

Sentinel should fail closed in CI for high/critical findings. For local agent development, start in monitor mode and move to enforce mode when the policy is tuned.
