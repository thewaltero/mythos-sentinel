export const CONTENT_RULES = [
  {
    id: 'MS-SECRET-001',
    title: 'Private key material detected',
    severity: 'critical',
    category: 'secrets',
    pattern: /-----BEGIN (RSA |OPENSSH |EC |DSA |)?PRIVATE KEY-----/i,
    recommendation: 'Remove private key material, rotate the key, and use a secret manager.',
    tags: ['secret', 'credential', 'wallet-risk']
  },
  {
    id: 'MS-SECRET-002',
    title: 'Potential wallet or API secret variable',
    severity: 'critical',
    category: 'secrets',
    pattern: /\b(PRIVATE_KEY|WALLET_PRIVATE_KEY|MNEMONIC|SEED_PHRASE|CDP_API_KEY_SECRET|OPENAI_API_KEY|ANTHROPIC_API_KEY)\b\s*[:=]\s*['\"]?[^\s'\"]{12,}/i,
    recommendation: 'Move secrets into a secret manager and never package them inside agent skills.',
    tags: ['secret', 'api-key', 'wallet-risk']
  },
  {
    id: 'MS-CMD-001',
    title: 'Remote script piped into shell',
    severity: 'critical',
    category: 'command-execution',
    pattern: /\b(curl|wget)\b[^\n|;]+\|\s*(sudo\s+)?(bash|sh|zsh)\b/i,
    recommendation: 'Do not pipe remote content directly into a shell. Pin and inspect installers.',
    tags: ['supply-chain', 'rce']
  },
  {
    id: 'MS-CMD-002',
    title: 'Dangerous recursive delete command',
    severity: 'critical',
    category: 'command-execution',
    pattern: /\brm\s+-rf\s+(\/|~|\$HOME|\.\.\/)/i,
    recommendation: 'Require explicit human approval for destructive commands.',
    tags: ['destructive', 'shell']
  },
  {
    id: 'MS-CMD-004',
    title: 'World-writable permission change',
    severity: 'high',
    category: 'command-execution',
    pattern: /\bchmod\s+(?:-R\s+)?777\b/i,
    recommendation: 'Avoid world-writable permissions. Use least-privilege file modes.',
    tags: ['filesystem', 'privilege']
  },
  {
    id: 'MS-CMD-005',
    title: 'Encoded PowerShell command',
    severity: 'high',
    category: 'command-execution',
    pattern: /\bpowershell(?:\.exe)?\b[^\n]*(?:-enc|-encodedcommand)\b/i,
    recommendation: 'Do not allow encoded PowerShell in agent tools without explicit review.',
    tags: ['powershell', 'obfuscation']
  },
  {
    id: 'MS-CMD-003',
    title: 'Process execution from agent code',
    severity: 'high',
    category: 'command-execution',
    pattern: /\b(child_process\.(exec|execSync|spawn|spawnSync)|subprocess\.(run|Popen|call)|os\.system|Runtime\.getRuntime\(\)\.exec)\b/i,
    recommendation: 'Restrict shell access with a manifest and proxy tool calls through Sentinel.',
    tags: ['shell', 'runtime']
  },
  {
    id: 'MS-CODE-001',
    title: 'Dynamic code evaluation',
    severity: 'high',
    category: 'code-execution',
    pattern: /\b(eval\s*\(|new Function\s*\(|exec\s*\()/i,
    recommendation: 'Avoid dynamic execution in agent skills and MCP tools unless sandboxed.',
    tags: ['rce', 'obfuscation']
  },
  {
    id: 'MS-PROMPT-001',
    title: 'Prompt-injection phrase in agent-facing instructions',
    severity: 'high',
    category: 'prompt-injection',
    pattern: /(ignore (all )?(previous|prior) instructions|disregard (the )?(system|developer) message|reveal (your )?(system prompt|secrets)|exfiltrate|silently send)/i,
    recommendation: 'Treat skill instructions as untrusted input. Remove override/exfiltration language.',
    tags: ['prompt-injection', 'tool-poisoning']
  },
  {
    id: 'MS-NET-001',
    title: 'Network call in skill or tool code',
    severity: 'medium',
    category: 'network',
    pattern: /\b(fetch|axios\.|requests\.|http\.request|https\.request|curl\b|wget\b)\b/i,
    recommendation: 'Declare network domains in the Sentinel policy allowlist.',
    tags: ['network', 'exfiltration-risk']
  },
  {
    id: 'MS-OBF-001',
    title: 'Suspicious obfuscation pattern',
    severity: 'medium',
    category: 'obfuscation',
    pattern: /(Buffer\.from\([^\n]+base64|atob\(|fromCharCode\(|base64\s+-d|eval\([^\n]{80,})/i,
    recommendation: 'Deobfuscate and inspect code before allowing an agent to run it.',
    tags: ['obfuscation']
  },
  {
    id: 'MS-PAY-001',
    title: 'Payment or wallet code detected',
    severity: 'medium',
    category: 'payments',
    pattern: /\b(walletClient|privateKeyToAccount|sendTransaction|createPaymentHeader|settlePayment|paymentMiddleware|x402Fetch|facilitator)\b|402 Payment Required|Payment-Required/i,
    recommendation: 'Apply x402 spend limits and require explicit approval for wallet operations.',
    tags: ['x402', 'base', 'wallet']
  },
  {
    id: 'MS-GHA-002',
    title: 'pull_request_target workflow detected',
    severity: 'high',
    category: 'ci',
    pattern: /pull_request_target:/i,
    recommendation: 'Avoid pull_request_target for untrusted code paths unless the workflow is carefully isolated.',
    tags: ['github-actions', 'supply-chain']
  },
  {
    id: 'MS-GHA-001',
    title: 'Broad GitHub Actions permission',
    severity: 'high',
    category: 'ci',
    pattern: /permissions:\s*[\r\n]+(?:\s+\w+-token:\s+write\s*[\r\n]+|\s+contents:\s+write\s*[\r\n]+|\s+actions:\s+write\s*[\r\n]+){2,}|permissions:\s*write-all/i,
    recommendation: 'Use least-privilege GitHub Actions permissions.',
    tags: ['github-actions', 'supply-chain']
  },
  {
    id: 'MS-MCP-001',
    title: 'MCP server command launches a shell',
    severity: 'medium',
    category: 'mcp',
    pattern: /\"command\"\s*:\s*\"(?:bash|sh|zsh|powershell|cmd(?:\.exe)?)\"/i,
    recommendation: 'Prefer direct executable commands over shell wrappers for MCP servers.',
    tags: ['mcp', 'tooling']
  },
  {
    id: 'MS-NPM-001',
    title: 'Package lifecycle script detected',
    severity: 'medium',
    category: 'supply-chain',
    pattern: /"(preinstall|install|postinstall|prepare)"\s*:\s*"[^"]+"/i,
    recommendation: 'Review package lifecycle scripts before agent installation.',
    tags: ['npm', 'supply-chain']
  }
];

export const PATH_RULES = [
  {
    id: 'MS-FS-001',
    title: 'Sensitive environment file included',
    severity: 'high',
    category: 'filesystem',
    pattern: /(^|\/)\.env(\.|$)/i,
    recommendation: 'Do not expose .env files to agents or package them in skills.',
    tags: ['secrets', 'filesystem']
  },
  {
    id: 'MS-FS-002',
    title: 'SSH key path included',
    severity: 'critical',
    category: 'filesystem',
    pattern: /(^|\/)(id_rsa|id_ed25519|\.ssh)(\/|$)/i,
    recommendation: 'Never let agents read SSH private keys.',
    tags: ['ssh', 'credential']
  },
  {
    id: 'MS-FS-004',
    title: 'Wallet or keystore file path included',
    severity: 'critical',
    category: 'filesystem',
    pattern: /(^|\/)(wallet\.json|keystore|UTC--|seed\.txt|mnemonic\.txt)(\/|$)/i,
    recommendation: 'Keep wallet and keystore files outside agent-accessible workspaces.',
    tags: ['wallet', 'credential']
  },
  {
    id: 'MS-FS-003',
    title: 'Private key file extension included',
    severity: 'critical',
    category: 'filesystem',
    pattern: /\.(pem|key|p12|pfx)$/i,
    recommendation: 'Move private key files out of the agent-accessible workspace.',
    tags: ['secret', 'credential']
  }
];
