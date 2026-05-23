#!/usr/bin/env node
import { runMcpServer } from '../src/mcp/server.js';

runMcpServer().catch((error) => {
  console.error(JSON.stringify({ level: 'error', message: error?.message || String(error) }));
  process.exit(1);
});
