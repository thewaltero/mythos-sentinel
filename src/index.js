export { scanPath, scanText } from './scanner/scan.js';
export {
  loadPolicy,
  defaultPolicy,
  evaluateFindings,
  checkPayment,
  checkCommand,
  checkFilesystemAccess,
  checkNetwork
} from './core/policy.js';
export { createSnapshot, diffSnapshots } from './core/snapshot.js';
export { createReceipt, verifyReceipt } from './core/receipt.js';
export { executeFallbackRoute, fetchBazaarResources, fetchBazaarSearch, importServicesFile, listServiceCategories, loadRouteScoreServices, recommendService, routeService, saveCustomServices, seedX402Services, scoreService, serviceForDomain, passiveTelemetryEvent } from './core/routescore.js';
export { appendTelemetryEvent, readTelemetryEvents, telemetrySummary, telemetryEnabled, telemetryPrivacy, setTelemetryEnabled } from './core/telemetry.js';
export { runMcpServer, handleMessage } from './mcp/server.js';
export { VERSION } from './version.js';
export { runMcpProxy, McpProxy, evaluateToolCall, classifyToolCall } from './mcp/proxy.js';

export { ingestX402Receipt, ingestX402ReceiptFile, normalizeX402Receipt, readX402Receipts, summarizeX402Receipts, receiptToTelemetryEvent } from './core/x402-receipts.js';
export { spendLedgerPath, readSpendLedger, dailySpend, recordSpend, effectiveSpend, mandateSpend, utcDateKey, SPEND_TIERS } from './core/spend-ledger.js';
export { createMandate, verifyMandate, checkMandate, loadMandates, findCoveringMandate, toMicroUSDC, fromMicroUSDC, MANDATE_DOMAIN, MANDATE_TYPES } from './core/mandates.js';
export { buildAttestationBundle, writeAttestationBundle, verifyAttestationBundle, committedPayload, signAttestationBundle, verifySignedAttestation, encodeEasData, submitAttestation, registerEasSchema, merkleRoot, canonicalJson, EAS_SCHEMA_STRING, EAS_ADDRESSES } from './core/attest.js';
export { buildDirectory, writeDirectory } from './core/directory.js';
