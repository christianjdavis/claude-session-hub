// Portions adapted from vswt (https://github.com/vana123/vswt), MIT License, (c) 2026 Vana Savych.
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** Resolve, drop trailing separators, lowercase on Windows. */
export function normalizePath(p: string): string {
  if (!p) return '';
  let r = path.resolve(p).replace(/[\\/]+$/, '');
  if (process.platform === 'win32') r = r.toLowerCase();
  return r;
}

/** Best-effort realpath; falls back to the input when the path is gone. */
export async function realpathSafe(p: string): Promise<string> {
  if (!p) return p;
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

export function expandHome(p: string): string {
  const t = p.trim();
  if (t === '~') return os.homedir();
  if (t.startsWith('~/') || t.startsWith('~\\')) return path.join(os.homedir(), t.slice(2));
  return t;
}

export function shortenHomePath(p: string): string {
  const home = os.homedir();
  if (p === home) return '~';
  if (p.startsWith(home + path.sep)) return '~' + p.slice(home.length);
  return p;
}

/** True when `child` equals or lies under `root` (both already normalized). */
export function isUnder(root: string, child: string): boolean {
  if (!root || !child) return false;
  if (child === root) return true;
  return child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** Path of `p` relative to the first root containing it, else shortened absolute path. */
export function relToRoots(roots: string[], p: string): string {
  for (const r of roots) {
    if (isUnder(r, p)) {
      const rel = path.relative(r, p);
      return rel === '' ? path.basename(r) : rel;
    }
  }
  return shortenHomePath(p);
}

export function claudeHome(): string {
  const env = process.env['CLAUDE_CONFIG_DIR'];
  return env && env.trim() ? expandHome(env) : path.join(os.homedir(), '.claude');
}

export function projectsDir(): string {
  return path.join(claudeHome(), 'projects');
}
export function sessionsDir(): string {
  return path.join(claudeHome(), 'sessions');
}
export function jobsDir(): string {
  return path.join(claudeHome(), 'jobs');
}
