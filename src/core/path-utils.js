import path from 'node:path';

export function normalizePath(filePath) {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function toPosixRelative(base, target) {
  return normalizePath(path.relative(base, target) || '.');
}

export function globToRegExp(glob) {
  const normalized = normalizePath(glob).replace(/^\/+/, '');
  let out = '^';
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];
    const next = normalized[i + 1];
    if (c === '*') {
      if (next === '*') {
        const after = normalized[i + 2];
        if (after === '/') {
          out += '(?:.*\/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('\\.^$+{}()|[]'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  out += '$';
  return new RegExp(out);
}

export function matchesAnyGlob(filePath, globs = []) {
  const normalized = normalizePath(filePath);
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}

export function safeJoinInside(base, target) {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(resolvedBase, target);
  if (!resolvedTarget.startsWith(resolvedBase)) {
    throw new Error(`Refusing to access path outside ${resolvedBase}: ${target}`);
  }
  return resolvedTarget;
}
