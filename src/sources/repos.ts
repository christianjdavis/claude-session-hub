import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', '.git', 'Library', '__pycache__', '.venv', 'venv']);

/** Git repositories under `roots` up to `depth` levels (a repo's own subtree is not descended). */
export async function scanRepos(roots: string[], depth: number): Promise<Set<string>> {
  const found = new Set<string>();
  await Promise.all(roots.map(r => walk(r, depth, found)));
  return found;
}

async function walk(dir: string, depth: number, found: Set<string>): Promise<void> {
  if (await exists(path.join(dir, '.git'))) {
    found.add(dir);
    return;
  }
  if (depth <= 0) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const subdirs = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
    .map(e => path.join(dir, e.name));
  await Promise.all(subdirs.map(d => walk(d, depth - 1, found)));
}

export interface DirEntry {
  name: string;
  path: string;
  isGit: boolean;
}

/** One row of a directory listing for the file browser. */
export interface FsEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  /** Directories only: contains a `.git`. */
  isGit?: boolean;
  /** Dotfile, build output, or `.gitignore`d: hidden unless the user asks to see ignored entries. */
  ignored: boolean;
}

/** Immediate subdirectories of `dir` worth showing (no dotfolders or build output), each flagged if it is a git repo. */
export async function listDirs(dir: string): Promise<DirEntry[]> {
  const entries = await listEntries(dir, null, false);
  return entries.filter(e => e.kind === 'dir').map(e => ({ name: e.name, path: e.path, isGit: e.isGit ?? false }));
}

/**
 * Everything in `dir`, directories first. An entry is `ignored` when it is a dotfile, in the SKIP
 * set, or (inside a repo) matched by `.gitignore`; those are dropped unless `showHidden`.
 */
export async function listEntries(dir: string, repoRoot: string | null, showHidden: boolean): Promise<FsEntry[]> {
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const classified = await Promise.all(
    dirents.map(async (d): Promise<{ name: string; isDir: boolean } | null> => {
      if (d.isDirectory()) return { name: d.name, isDir: true };
      if (d.isFile()) return { name: d.name, isDir: false };
      if (!d.isSymbolicLink()) return null;
      try {
        const st = await fs.stat(path.join(dir, d.name));
        return { name: d.name, isDir: st.isDirectory() };
      } catch {
        return null; // broken link
      }
    })
  );
  const present = classified.filter((c): c is { name: string; isDir: boolean } => c !== null);
  const basic = new Set(present.filter(c => c.name.startsWith('.') || SKIP.has(c.name)).map(c => c.name));
  // One git call for the whole listing; only names not already hidden need checking.
  const candidates = present.filter(c => !basic.has(c.name)).map(c => c.name);
  const gitIgnored = repoRoot && candidates.length ? await checkIgnore(repoRoot, dir, candidates) : new Set<string>();
  const out: FsEntry[] = [];
  for (const c of present) {
    const ignored = basic.has(c.name) || gitIgnored.has(c.name);
    if (ignored && !showHidden) continue;
    const p = path.join(dir, c.name);
    if (c.isDir) out.push({ name: c.name, path: p, kind: 'dir', isGit: await exists(path.join(p, '.git')), ignored });
    else out.push({ name: c.name, path: p, kind: 'file', ignored });
  }
  return out.sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name));
}

/** Names in `dir` (relative to it) that `.gitignore` rules of `repoRoot` exclude. Exit code 1 just means "none". */
function checkIgnore(repoRoot: string, dir: string, names: string[]): Promise<Set<string>> {
  return new Promise(resolve => {
    const child = execFile('git', ['-C', dir, 'check-ignore', '-z', '--stdin'], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err && (err as { code?: unknown }).code !== 1) return resolve(new Set());
      resolve(new Set(String(stdout).split('\0').filter(Boolean)));
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(names.join('\0') + '\0');
  });
}

const gitCache = new Map<string, boolean>();

/** Nearest ancestor of `p` (inclusive) containing `.git`, not climbing above `stopAt` when given. */
export async function findRepoRoot(p: string, stopAt: string | null): Promise<string | null> {
  let cur = p;
  for (let i = 0; i < 24; i++) {
    let isRepo = gitCache.get(cur);
    if (isRepo === undefined) {
      isRepo = await exists(path.join(cur, '.git'));
      gitCache.set(cur, isRepo);
    }
    if (isRepo) return cur;
    if (stopAt !== null && cur === stopAt) return null;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

export function clearRepoCache(): void {
  gitCache.clear();
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
