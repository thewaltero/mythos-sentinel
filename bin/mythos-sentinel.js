#!/usr/bin/env node
import { runCli } from '../src/cli.js';

runCli(process.argv.slice(2)).catch((error) => {
  console.error(`\nmythos-sentinel failed: ${error?.message || error}`);
  if (process.env.MYTHOS_DEBUG) console.error(error?.stack || error);
  process.exit(1);
});
