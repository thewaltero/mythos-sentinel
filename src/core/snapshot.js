import path from 'node:path';
import { walkFiles, sha256File } from './fs.js';

export async function createSnapshot(rootDir = '.', options = {}) {
  const root = path.resolve(rootDir);
  const files = await walkFiles(root, { ignore: options.ignore || [] });
  const snapshotFiles = [];
  for (const file of files) {
    snapshotFiles.push({ path: file.rel, size: file.size, sha256: await sha256File(file.absPath) });
  }
  return {
    schema: 'https://mythos.dev/schemas/snapshot.v0.json',
    createdAt: new Date().toISOString(),
    root,
    files: snapshotFiles
  };
}

export function diffSnapshots(before, after) {
  const b = new Map((before.files || []).map((file) => [file.path, file]));
  const a = new Map((after.files || []).map((file) => [file.path, file]));
  const added = [];
  const modified = [];
  const deleted = [];

  for (const [filePath, afterFile] of a.entries()) {
    const beforeFile = b.get(filePath);
    if (!beforeFile) added.push(afterFile);
    else if (beforeFile.sha256 !== afterFile.sha256 || beforeFile.size !== afterFile.size) modified.push({ before: beforeFile, after: afterFile });
  }
  for (const [filePath, beforeFile] of b.entries()) {
    if (!a.has(filePath)) deleted.push(beforeFile);
  }
  return { added, modified, deleted, changedCount: added.length + modified.length + deleted.length };
}
