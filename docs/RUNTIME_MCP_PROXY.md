# Runtime MCP Proxy

Runtime proxy mode turns Mythos Sentinel from a permission-checking MCP server into an enforcement layer.

```txt
Agent / Claude / Cursor / custom runtime
  -> mythos-sentinel proxy
  -> upstream MCP servers and x402 tools
```

The agent still sees normal MCP tools. Sentinel mirrors upstream tools, checks each `tools/call`, and only forwards allowed calls.

## Why it matters

Direct guardrail mode depends on the agent remembering to ask Sentinel before risky actions. Proxy mode removes that weak point: every proxied tool call is preflighted before the upstream server receives it.

Sentinel checks:

- x402/Base payment domain, amount, daily spend, unknown-domain trial rules, and RouteScore signal
- shell commands against blocked and approval-required patterns
- file reads/writes against deny and allow rules
- network domains against deny/allow rules

`block` and `approval_required` decisions are not forwarded to upstream tools.

## Run

```bash
mythos-sentinel proxy
```

or with an explicit policy/config:

```bash
mythos-sentinel proxy --policy mythos.policy.json
mythos-sentinel proxy --config proxy.json
```

## Claude/Cursor config

```json
{
  "mcpServers": {
    "mythos-sentinel-proxy": {
      "command": "npx",
      "args": ["mythos-sentinel", "proxy"]
    }
  }
}
```

## Configure upstream tools

Add upstream MCP servers in `mythos.policy.json`:

```json
{
  "mcpProxy": {
    "enabled": true,
    "mode": "enforce",
    "approvalMode": "return_error",
    "toolNameStrategy": "preserve_unless_collision",
    "upstreams": [
      {
        "id": "search",
        "command": "npx",
        "args": ["-y", "your-search-mcp-server"]
      },
      {
        "id": "browser",
        "command": "npx",
        "args": ["-y", "your-browser-mcp-server"]
      }
    ]
  }
}
```

If two upstreams expose the same tool name, Sentinel automatically prefixes the collision as `upstreamId__toolName`.

## Decision behavior

- `allow`: forward to upstream and attach `_sentinel` metadata to `structuredContent`
- `approval_required`: return an MCP tool error before upstream execution
- `block`: return an MCP tool error before upstream execution
- `upstream_error`: upstream failed after Sentinel allowed the call

## Positioning

Use direct MCP mode for lightweight projects where the agent voluntarily asks Sentinel. Use proxy mode for wallet-enabled agents, paid x402 tools, shell/file access, or demos where enforcement must be visible.
