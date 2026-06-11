import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir, exists } from './fs.js';
import { readX402Receipts } from './x402-receipts.js';
import { dailySpend } from './spend-ledger.js';

/**
 * Receipt attestation: bundle local receipts into a single canonical,
 * hash-committed payload that can be (a) signed off-chain (EIP-712) and
 * (b) attested on-chain via EAS (Ethereum Attestation Service) on Base.
 *
 * EAS is deployed as a predeploy on OP-stack chains, including Base and
 * Base Sepolia: EAS 0x4200...0021, SchemaRegistry 0x4200...0020.
 *
 * Honest framing (see THREAT_MODEL.md "On-chain attestation"): an attestation
 * proves that *these exact local records existed and were committed to at
 * this time by this key*. It is tamper-evidence and timestamping — not proof
 * that the recorded work or payments were themselves truthful.
 *
 * Everything except `submitAttestation` is offline and deterministic.
 */

export const ATTESTATION_VERSION = '1';
export const DEFAULT_ATTESTATIONS_DIR = '.mythos/attestations';

// EAS schema this bundle encodes to. Register once per network with
// `attest schema --broadcast`, then put the returned UID in
// policy.attestation.schemaUid.
export const EAS_SCHEMA_STRING = 'string product,string bundleVersion,bytes32 bundleHash,bytes32 merkleRoot,uint64 itemCount,string uri';

export const EAS_ADDRESSES = Object.freeze({
  base: { chainId: 8453, eas: '0x4200000000000000000000000000000000000021', schemaRegistry: '0x4200000000000000000000000000000000000020', rpc: 'https://mainnet.base.org' },
  'base-sepolia': { chainId: 84532, eas: '0x4200000000000000000000000000000000000021', schemaRegistry: '0x4200000000000000000000000000000000000020', rpc: 'https://sepolia.base.org' }
});

const EAS_ABI = [
  'function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data)) payable returns (bytes32)'
];
const SCHEMA_REGISTRY_ABI = [
  'function register(string schema,address resolver,bool revocable) returns (bytes32)'
];

export const ATTESTATION_DOMAIN = Object.freeze({ name: 'MythosSentinel', version: ATTESTATION_VERSION });
export const ATTESTATION_TYPES = Object.freeze({
  ReceiptBundle: [
    { name: 'product', type: 'string' },
    { name: 'bundleVersion', type: 'string' },
    { name: 'bundleHash', type: 'bytes32' },
    { name: 'merkleRoot', type: 'bytes32' },
    { name: 'itemCount', type: 'uint64' },
    { name: 'createdAt', type: 'string' }
  ]
});

export function attestationsDir(rootDir = process.cwd()) {
  return path.join(rootDir, DEFAULT_ATTESTATIONS_DIR);
}

export function sha256Hex(input) {
  return `0x${crypto.createHash('sha256').update(input).digest('hex')}`;
}

/** Canonical JSON: stable key order so hashes are reproducible. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Merkle root over sorted leaf hashes (pairwise sha256, odd leaf carried). */
export function merkleRoot(leafHexes) {
  if (!leafHexes.length) return sha256Hex('');
  let level = [...leafHexes].sort();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) next.push(level[i]);
      else next.push(sha256Hex(Buffer.concat([Buffer.from(level[i].slice(2), 'hex'), Buffer.from(level[i + 1].slice(2), 'hex')])));
    }
    level = next;
  }
  return level[0];
}

async function collectItems({ rootDir, includePaths = [] }) {
  const items = [];

  // 1. x402 receipts recorded by Sentinel.
  for (const receipt of await readX402Receipts({ rootDir })) {
    const { storePath, ...stable } = receipt;
    items.push({ type: 'x402-receipt', id: receipt.receiptId || 'unknown', sha256: sha256Hex(canonicalJson(stable)) });
  }

  // 2. Today's spend ledger summary.
  const spend = await dailySpend({ rootDir });
  if (spend.entries > 0) items.push({ type: 'spend-ledger-day', id: spend.date, sha256: sha256Hex(canonicalJson(spend)) });

  // 3. Explicit extra files: Sentinel workspace receipts, mythos-router
  //    receipts, anything the caller wants committed into the bundle.
  for (const p of includePaths) {
    const abs = path.resolve(rootDir, p);
    if (!(await exists(abs))) continue;
    const raw = await fs.readFile(abs);
    items.push({ type: 'file', id: path.relative(rootDir, abs) || path.basename(abs), sha256: sha256Hex(raw) });
  }

  return items;
}

/**
 * The exact fields committed to by bundleHash. Mutable envelope fields added
 * after building (signed, onchain, storePath) are deliberately NOT part of
 * the commitment — they attach evidence about the bundle without changing
 * what the bundle attests to.
 */
export function committedPayload(bundle) {
  return {
    version: bundle.version,
    product: bundle.product,
    createdAt: bundle.createdAt,
    itemCount: bundle.itemCount,
    items: bundle.items,
    merkleRoot: bundle.merkleRoot,
    uri: bundle.uri || ''
  };
}

/** Build a deterministic attestation bundle from local records. Offline. */
export async function buildAttestationBundle({ rootDir = process.cwd(), includePaths = [], product = 'mythos-sentinel', uri = '' } = {}) {
  const items = await collectItems({ rootDir, includePaths });
  const payload = {
    version: ATTESTATION_VERSION,
    product,
    createdAt: new Date().toISOString(),
    itemCount: items.length,
    items: items.slice().sort((a, b) => a.sha256.localeCompare(b.sha256)),
    merkleRoot: merkleRoot(items.map((i) => i.sha256)),
    uri: String(uri || '')
  };
  payload.bundleHash = sha256Hex(canonicalJson(committedPayload(payload)));
  return payload;
}

export async function writeAttestationBundle(bundle, { rootDir = process.cwd() } = {}) {
  const dir = attestationsDir(rootDir);
  await ensureDir(dir);
  const file = path.join(dir, `${bundle.createdAt.replace(/[:.]/g, '-')}-bundle.json`);
  await fs.writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  return file;
}

/** Recompute a bundle's hashes and report any drift. Offline. */
export function verifyAttestationBundle(bundle) {
  const reasons = [];
  const recomputedRoot = merkleRoot((bundle.items || []).map((i) => i.sha256));
  if (recomputedRoot !== bundle.merkleRoot) reasons.push(`merkleRoot mismatch: recomputed ${recomputedRoot}, bundle says ${bundle.merkleRoot}`);
  const recomputedHash = sha256Hex(canonicalJson(committedPayload(bundle)));
  if (recomputedHash !== bundle.bundleHash) reasons.push(`bundleHash mismatch: recomputed ${recomputedHash}, bundle says ${bundle.bundleHash}`);
  return reasons.length ? { ok: false, reasons } : { ok: true, reasons: ['bundle hashes verified'] };
}

async function loadEthers() {
  try {
    return await import('ethers');
  } catch {
    throw new Error('On-chain attestation requires the optional "ethers" dependency. Install it with: npm install ethers');
  }
}

/** Sign the bundle commitment off-chain (EIP-712). Offline, gas-free. */
export async function signAttestationBundle(bundle, { privateKey }) {
  if (!privateKey) throw new Error('signing requires a private key (use an env var; never commit keys)');
  const { Wallet } = await loadEthers();
  const wallet = new Wallet(privateKey);
  const message = {
    product: bundle.product,
    bundleVersion: bundle.version,
    bundleHash: bundle.bundleHash,
    merkleRoot: bundle.merkleRoot,
    itemCount: String(bundle.itemCount),
    createdAt: bundle.createdAt
  };
  const signature = await wallet.signTypedData(ATTESTATION_DOMAIN, ATTESTATION_TYPES, message);
  return { signature, signer: wallet.address, message };
}

export async function verifySignedAttestation({ message, signature, signer }) {
  try {
    const { verifyTypedData } = await loadEthers();
    const recovered = verifyTypedData(ATTESTATION_DOMAIN, ATTESTATION_TYPES, message, signature);
    if (signer && recovered.toLowerCase() !== String(signer).toLowerCase()) {
      return { ok: false, signer: recovered, reasons: [`signature recovers ${recovered}, record claims ${signer}`] };
    }
    return { ok: true, signer: recovered, reasons: ['attestation signature valid'] };
  } catch (error) {
    return { ok: false, signer: null, reasons: [`verification failed: ${error.message}`] };
  }
}

/** ABI-encode the bundle per the EAS schema. Offline. */
export async function encodeEasData(bundle) {
  const { AbiCoder } = await loadEthers();
  return AbiCoder.defaultAbiCoder().encode(
    ['string', 'string', 'bytes32', 'bytes32', 'uint64', 'string'],
    [bundle.product, bundle.version, bundle.bundleHash, bundle.merkleRoot, BigInt(bundle.itemCount), bundle.uri || '']
  );
}

/**
 * Submit the bundle as an EAS attestation on Base / Base Sepolia.
 *
 * NETWORK + REAL FUNDS: never called unless the caller passes broadcast:true.
 * Requires policy/flags to supply schemaUid, and a funded key via env var.
 * Test on base-sepolia first — always.
 */
export async function submitAttestation(bundle, { network = 'base-sepolia', schemaUid, privateKey, rpcUrl } = {}) {
  const net = EAS_ADDRESSES[network];
  if (!net) throw new Error(`unknown network "${network}" (expected: ${Object.keys(EAS_ADDRESSES).join(', ')})`);
  if (!schemaUid) throw new Error('schemaUid required: register the schema once with `attest schema --broadcast`, then set policy.attestation.schemaUid');
  if (!privateKey) throw new Error('private key required via env var (e.g. SENTINEL_ATTEST_KEY); use a dedicated low-value key');
  const { Wallet, JsonRpcProvider, Contract } = await loadEthers();
  const provider = new JsonRpcProvider(rpcUrl || net.rpc, net.chainId);
  const wallet = new Wallet(privateKey, provider);
  const eas = new Contract(net.eas, EAS_ABI, wallet);
  const data = await encodeEasData(bundle);
  const tx = await eas.attest({
    schema: schemaUid,
    data: {
      recipient: '0x0000000000000000000000000000000000000000',
      expirationTime: 0n,
      revocable: true,
      refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',
      data,
      value: 0n
    }
  });
  const receipt = await tx.wait();
  return { ok: receipt.status === 1, txHash: receipt.hash, network, attester: wallet.address };
}

/** Register the bundle schema on EAS (one-time per network). */
export async function registerEasSchema({ network = 'base-sepolia', privateKey, rpcUrl } = {}) {
  const net = EAS_ADDRESSES[network];
  if (!net) throw new Error(`unknown network "${network}"`);
  if (!privateKey) throw new Error('private key required via env var');
  const { Wallet, JsonRpcProvider, Contract } = await loadEthers();
  const provider = new JsonRpcProvider(rpcUrl || net.rpc, net.chainId);
  const wallet = new Wallet(privateKey, provider);
  const registry = new Contract(net.schemaRegistry, SCHEMA_REGISTRY_ABI, wallet);
  const tx = await registry.register(EAS_SCHEMA_STRING, '0x0000000000000000000000000000000000000000', true);
  const receipt = await tx.wait();
  return { ok: receipt.status === 1, txHash: receipt.hash, network, schema: EAS_SCHEMA_STRING };
}
