import readline from 'node:readline';
import { scanPath } from '../scanner/scan.js';
import { loadPolicy, checkPayment, checkCommand, checkFilesystemAccess, checkNetwork } from '../core/policy.js';
import { createSnapshot } from '../core/snapshot.js';
import { loadRouteScoreServices, recommendService, routeService, serviceForDomain, scoreService, listServiceCategories } from '../core/routescore.js';
import { VERSION } from '../version.js';
import { normalizeX402Receipt } from '../core/x402-receipts.js';

const tools = [
  {
    name: 'sentinel_scan_path',
    description: 'Scan an agent skill, MCP server, repository, or folder for risky commands, prompt injection, secrets, wallet access, and policy violations.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to scan. Defaults to current directory.' },
        policyPath: { type: 'string', description: 'Path to mythos.policy.json.' }
      }
    }
  },
  {
    name: 'sentinel_check_x402_payment',
    description: 'Check whether an x402/Base payment is allowed by the local Sentinel policy.',
    inputSchema: {
      type: 'object',
      required: ['domain', 'amountUSDC'],
      properties: {
        domain: { type: 'string' },
        amountUSDC: { type: 'number' },
        dailySpentUSDC: { type: 'number' },
        policyPath: { type: 'string' }
      }
    }
  },
  {
    name: 'sentinel_check_command',
    description: 'Check whether a shell command is allowed, blocked, or requires approval by the local Sentinel policy.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string' },
        policyPath: { type: 'string' }
      }
    }
  },
  {
    name: 'sentinel_check_file',
    description: 'Check whether an agent can read or write a file path under the local Sentinel policy.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        operation: { type: 'string', enum: ['read', 'write'] },
        policyPath: { type: 'string' }
      }
    }
  },
  {
    name: 'sentinel_check_network',
    description: 'Check whether network access to a domain is allowed by the local Sentinel policy.',
    inputSchema: {
      type: 'object',
      required: ['domain'],
      properties: {
        domain: { type: 'string' },
        policyPath: { type: 'string' }
      }
    }
  },
  {
    name: 'sentinel_recommend_x402_service',
    description: 'Recommend a seed x402/Base paid API by category, price, and RouteScore before an agent spends money.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Example: web_search, content_extraction, inference, web3_data, wallet_intel.' },
        maxPriceUSDC: { type: 'number', description: 'Maximum acceptable price per call.' }
      }
    }
  },
  {
    name: 'sentinel_route_x402_service',
    description: 'Select the best known x402 service plus fallback services by category, price, query, and local RouteScore telemetry.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Example: web_search, content_extraction, inference, web3_data, wallet_intel.' },
        maxPriceUSDC: { type: 'number', description: 'Maximum acceptable price per call.' },
        query: { type: 'string', description: 'Optional semantic keyword filter over local/imported services.' },
        minScore: { type: 'number', description: 'Optional minimum RouteScore required for selected/fallback services.' },
        policyPath: { type: 'string' }
      }
    }
  },
  {
    name: 'sentinel_list_service_categories',
    description: 'List supported RouteScore service categories and aliases for routing paid agent APIs.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'sentinel_parse_x402_receipt',
    description: 'Normalize an x402 payment receipt or payment-response payload without storing prompts, responses, secrets, or wallet balances.',
    inputSchema: {
      type: 'object',
      properties: {
        receipt: { type: 'object', description: 'x402 receipt/payment response JSON.' },
        raw: { type: 'string', description: 'Optional raw/base64 payment response blob.' }
      }
    }
  },
  {
    name: 'sentinel_score_x402_domain',
    description: 'Return the seed catalog score for a payment domain if Sentinel knows it.',
    inputSchema: {
      type: 'object',
      required: ['domain'],
      properties: {
        domain: { type: 'string' }
      }
    }
  },
  {
    name: 'sentinel_snapshot',
    description: 'Create a hash snapshot of a workspace before an agent changes files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to snapshot. Defaults to current directory.' }
      }
    }
  }
];

export async function runMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message;
    try {
      message = JSON.parse(trimmed);
      const response = await handleMessage(message);
      if (response) output.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      const id = message?.id ?? null;
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: error.message } })}\n`);
    }
  }
}

export async function handleMessage(message) {
  const { id, method, params = {} } = message;
  if (!method || id === undefined) return null;
  if (method === 'initialize') {
    return result(id, {
      protocolVersion: params.protocolVersion || '2025-06-18',
      serverInfo: { name: 'mythos-sentinel', version: VERSION },
      capabilities: { tools: {} }
    });
  }
  if (method === 'tools/list') return result(id, { tools });
  if (method === 'tools/call') return result(id, await callTool(params.name, params.arguments || {}));
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

async function callTool(name, args) {
  const policy = await loadPolicy(args.policyPath || 'mythos.policy.json');
  if (name === 'sentinel_scan_path') {
    const report = await scanPath(args.path || '.', { policy });
    return content(report);
  }
  if (name === 'sentinel_check_x402_payment') {
    const services = await loadRouteScoreServices({ rootDir: process.cwd() });
    const matched = serviceForDomain(args.domain, services);
    const score = matched ? scoreService(matched).score : args.routeScore;
    const decision = checkPayment({ domain: args.domain, amountUSDC: args.amountUSDC, dailySpentUSDC: args.dailySpentUSDC || 0, unknownDailySpentUSDC: args.unknownDailySpentUSDC || 0, routeScore: score, category: args.category, knownService: Boolean(matched) }, policy);
    return content(decision);
  }
  if (name === 'sentinel_check_command') {
    return content(checkCommand({ command: args.command }, policy));
  }
  if (name === 'sentinel_check_file') {
    return content(checkFilesystemAccess({ filePath: args.path, operation: args.operation || 'read' }, policy));
  }
  if (name === 'sentinel_check_network') {
    return content(checkNetwork({ domain: args.domain }, policy));
  }
  if (name === 'sentinel_recommend_x402_service') {
    const services = await loadRouteScoreServices({ rootDir: process.cwd() });
    return content(recommendService({ category: args.category, maxPriceUSDC: args.maxPriceUSDC, query: args.query, services }));
  }
  if (name === 'sentinel_route_x402_service') {
    const services = await loadRouteScoreServices({ rootDir: process.cwd() });
    return content(routeService({ category: args.category, maxPriceUSDC: args.maxPriceUSDC, query: args.query, minScore: args.minScore || 0, services }));
  }
  if (name === 'sentinel_list_service_categories') {
    return content({ ok: true, categories: listServiceCategories() });
  }
  if (name === 'sentinel_parse_x402_receipt') {
    return content(normalizeX402Receipt(args.receipt || args.raw || args, { source: 'mcp' }));
  }
  if (name === 'sentinel_score_x402_domain') {
    const services = await loadRouteScoreServices({ rootDir: process.cwd() });
    const matched = serviceForDomain(args.domain, services);
    return content(matched ? scoreService(matched) : { ok: false, decision: 'unknown', domain: args.domain, reasons: ['domain is not in the local RouteScore catalog'] });
  }
  if (name === 'sentinel_snapshot') {
    const snapshot = await createSnapshot(args.path || '.');
    return content(snapshot);
  }
  throw new Error(`Unknown tool: ${name}`);
}

function content(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError: data.ok === false || data.summary?.ok === false
  };
}

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}
