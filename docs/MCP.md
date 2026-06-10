# MCP usage

Mythos Sentinel exposes a local JSON-RPC/MCP-style server so agent clients can ask for policy decisions before using risky capabilities.

Run:

```bash
mythos-sentinel mcp
```

Example config:

```json
{
  "mcpServers": {
    "mythos-sentinel": {
      "command": "npx",
      "args": ["mythos-sentinel", "mcp"]
    }
  }
}
```

## Tools

- `sentinel_scan_path` — scan a folder, skill, MCP server, or repository.
- `sentinel_check_command` — decide whether a shell command is allowed, blocked, or needs approval.
- `sentinel_check_file` — decide whether a file read/write is allowed.
- `sentinel_check_network` — decide whether a domain is allowed.
- `sentinel_check_x402_payment` — decide whether an x402/Base payment is allowed.
- `sentinel_recommend_x402_service` — recommend a paid API by category and price.
- `sentinel_route_x402_service` — return a selected service plus fallback route plan.
- `sentinel_list_service_categories` — list normalized service categories and aliases.
- `sentinel_parse_x402_receipt` — normalize a receipt-like payload without storing it.
- `sentinel_score_x402_domain` — return a RouteScore signal for a known payment domain.
- `sentinel_snapshot` — create a file hash snapshot before agent work.

## Runtime proxy mode

Direct MCP mode gives agents Sentinel tools to ask for permission. Runtime proxy mode places Sentinel in the call path of upstream MCP servers: recognized payment, shell, file, and network intent is gated before forwarding, budgets are enforced from Sentinel's own spend ledger, and unrecognized calls follow `mcpProxy.defaultAction` (`allow` by default; set `approval_required` or `block` to fail closed). Classification is heuristic — see [THREAT_MODEL.md](../THREAT_MODEL.md) for exact guarantees.

```bash
mythos-sentinel proxy --config proxy.json
```

Example proxy config:

```json
{
  "upstreams": [
    {
      "name": "filesystem-tools",
      "command": "npx",
      "args": ["some-filesystem-mcp-server"]
    }
  ]
}
```

Flow:

```text
Agent / MCP client -> Mythos Sentinel Proxy -> upstream MCP server
```

Sentinel classifies tool calls, checks policy, blocks or gates risky calls, forwards allowed calls, and can record opt-in local telemetry for paid API calls.

## Design note

This is intentionally local and keyless. Sentinel does not need model API keys or wallet keys. For production, keep MCP clients scoped to the project directory and do not expose the server over a network socket.
