import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizePath, toPosixRelative, matchesAnyGlob } from './path-utils.js';

export const DEFAULT_IGNORES = [
  '.git/**', 'node_modules/**', 'dist/**', 'build/**', 'coverage/**', '.next/**', '.turbo/**',
  '.vercel/**', '.cache/**', '.mythos/reports/**', '.mythos/snapshots/**', '*.png', '*.jpg',
  '*.jpeg', '*.gif', '*.webp', '*.ico', '*.pdf', '*.zip', '*.gz', '*.tar', '*.lock', '*.sarif', 'mythos-receipt.json'
];

export async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function sha256File(filePath) {
  return sha256Buffer(await fs.readFile(filePath));
}

export function isLikelyText(buffer) {
  if (!buffer.length) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.includes(0)) return false;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length < 0.1;
}

export async function readTextMaybe(filePath, maxBytes = 512 * 1024) {
  const stat = await fs.stat(filePath);
  if (stat.size > maxBytes) return { skipped: true, reason: `file too large (${stat.size} bytes)` };
  const buffer = await fs.readFile(filePath);
  if (!isLikelyText(buffer)) return { skipped: true, reason: 'binary file' };
  return { text: buffer.toString('utf8'), size: stat.size };
}

export async function walkFiles(rootDir, options = {}) {
  const ignores = [...DEFAULT_IGNORES, ...(options.ignore || [])];
  const root = path.resolve(rootDir);
  const results = [];

  async function visit(absPath) {
    const rel = toPosixRelative(root, absPath);
    if (rel !== '.' && matchesAnyGlob(rel, ignores)) return;
    let stat;
    try {
      stat = await fs.lstat(absPath);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      const entries = await fs.readdir(absPath);
      for (const entry of entries) await visit(path.join(absPath, entry));
      return;
    }
    if (stat.isFile()) results.push({ absPath, rel: normalizePath(rel), size: stat.size });
  }

  if (!fsSync.existsSync(root)) throw new Error(`Path does not exist: ${rootDir}`);
  await visit(root);
  return results.sort((a, b) => a.rel.localeCompare(b.rel));
}

export async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}
