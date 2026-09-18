import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { Session } from '../model/types';
import { findRepoRoot } from './repos';
import { claudeHome, isUnder } from '../paths';

export type FileStatus = 'M' | 'A' | 'D' | 'R' | '?' | 'clean' | 'missing';

export interface ChangedFile {
  /** Absolute path. */
  path: string;
  /** Git refs to diff (`to` null = working tree). Absent = HEAD ↔ working tree. */
  refs?: { from: string | null; to: string | null };
  repoRoot: string | null;
  /** Working-tree status relative to HEAD ('clean' = touched by the session but already committed/unchanged). */
  status: FileStatus;
  /** Touched after the user's last prompt (i.e. in the turn under review). */
  thisTurn: boolean;
  /** Last time the session edited it (ms). */
  lastEditTs: number | null;
  /** Aggregate ("Files changed") entries only: part of a commit made during the session. */
  inCommits?: boolean;
  /** Aggregate entries only: differs from HEAD in the working tree (uncommitted). */
  inWorkingTree?: boolean;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface Commit {
  sha: string;
  short: string;
  subject: string;
  ts: number;
  author: string;
  repoRoot: string;
  /** First parent sha; null for a root commit. */
  parent: string | null;
  /** Filled by the prefetcher so commit rows expand without a round trip. */
  files?: ChangedFile[];
}

/** Everything a session row needs to render its groups, in one call. */
export interface SessionGroups {
  commits: Commit[];
  /** Default branch to compare against (null: not a repo / no candidate). */
  base: string | null;
  /** Known only after the branch group was expanded once (the diff is the expensive part). */
  branchCount: number | null;
  /** Start of the "Files changed" range: parent of the oldest session commit, HEAD when there are none, null outside git. */
  from: string | null;
  /** PR-style aggregate: every file the session changed across its commits plus uncommitted work. */
  files: ChangedFile[];
}

/** `git hash-object -t tree /dev/null`: the diff base for a root commit. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface TouchScan {
  touches: Map<string, number>;
  /** Timestamp of the last human prompt seen anywhere in the transcript (full scan). */
  lastHumanTs: number | null;
  /** Directories shell commands worked in (`cd X`, `git -C X`): repos edited without Edit/Write. */
  dirs: Set<string>;
}

// ---------------------------------------------------------------------------------------------
// Caches. Everything here is keyed so a repeat call while nothing changed is a memory lookup.
// `invalidateRepo` is called when a transcript under that repo changes (the only thing that
// edits a repo while the hub is looking at it).
// ---------------------------------------------------------------------------------------------

const touchCache = new Map<string, { key: string; scan: TouchScan }>();
const EMPTY: TouchScan = { touches: new Map(), lastHumanTs: null, dirs: new Set() };
const MAX_DIR_HINTS = 32;
const CD_RE = /(?:^|&&|\|\||;|\n)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
const GIT_C_RE = /\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;

const STATUS_TTL_MS = 5_000;
const statusCache = new Map<string, { at: number; map: Map<string, FileStatus> }>();

const COMMIT_TTL_MS = 10_000;
const commitCache = new Map<string, { at: number; commits: Commit[] }>();

const COMMIT_FILES_MAX = 300;
const commitFilesCache = new Map<string, ChangedFile[]>();

const baseCache = new Map<string, string | null>();

const BRANCH_TTL_MS = 15_000;
const branchCache = new Map<string, { at: number; result: { mergeBase: string; files: ChangedFile[] } | null }>();

export function invalidateRepo(repoRoot: string): void {
  statusCache.delete(repoRoot);
  for (const k of [...commitCache.keys()]) if (k.startsWith(repoRoot + '|')) commitCache.delete(k);
  for (const k of [...branchCache.keys()]) if (k.startsWith(repoRoot + '|')) branchCache.delete(k);
}

export function invalidateAll(): void {
  touchCache.clear();
  statusCache.clear();
  commitCache.clear();
  commitFilesCache.clear();
  baseCache.clear();
  branchCache.clear();
}

/** Files this session edited (from Edit/Write tool_use records), with the last edit timestamp. */
export async function touchedFiles(session: Session): Promise<TouchScan> {
  if (!session.filePath) return EMPTY;
  // Subagents (Agent tool) write their own transcripts next to the parent's; their edits count too.
  const files = [session.filePath, ...(await subagentTranscripts(session))];
  const stats = await Promise.all(files.map(f => fs.promises.stat(f).catch(() => null)));
  if (!stats[0]) return EMPTY;
  const key = stats.map(s => (s ? `${s.mtimeMs}:${s.size}` : '-')).join('|');
  const cached = touchCache.get(session.filePath);
  if (cached && cached.key === key) return cached.scan;

  const touches = new Map<string, number>();
  const dirs = new Set<string>();
  let lastHumanTs: number | null = null;
  const home = process.env['HOME'] ?? '';
  const addDir = (raw: string) => {
    if (dirs.size >= MAX_DIR_HINTS || raw.includes('$')) return;
    const expanded = raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
    dirs.add(path.isAbsolute(expanded) ? path.normalize(expanded) : path.join(session.cwd, expanded));
  };
  for (let i = 0; i < files.length; i++) {
    if (!stats[i]) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(files[i] as string, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      // Human prompts carry origin.kind === "human" (newer) or promptSource (older); both are cheap substring checks.
      if (line.includes('"type":"user"') && (line.includes('"kind":"human"') || line.includes('"promptSource"'))) {
        const m = /"timestamp":"([^"]+)"/.exec(line);
        if (m) {
          const t = Date.parse(m[1] as string);
          if (!Number.isNaN(t)) lastHumanTs = t;
        }
        continue;
      }
      // Cheap prefilter before JSON.parse.
      if (!line.includes('"tool_use"') || !(line.includes('"file_path"') || line.includes('"notebook_path"') || line.includes('"name":"Bash"'))) continue;
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (o['type'] !== 'assistant') continue;
      const ts = typeof o['timestamp'] === 'string' ? Date.parse(o['timestamp']) : NaN;
      const msg = o['message'];
      const content = msg && typeof msg === 'object' ? (msg as Record<string, unknown>)['content'] : null;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const p = part as Record<string, unknown>;
        if (p['type'] !== 'tool_use') continue;
        const input = p['input'];
        if (!input || typeof input !== 'object') continue;
        if (p['name'] === 'Bash') {
          const cmd = (input as Record<string, unknown>)['command'];
          if (typeof cmd === 'string') for (const re of [CD_RE, GIT_C_RE]) for (const m of cmd.matchAll(re)) addDir((m[1] ?? m[2] ?? m[3]) as string);
          continue;
        }
        if (!EDIT_TOOLS.has(String(p['name']))) continue;
        const raw = (input as Record<string, unknown>)['file_path'] ?? (input as Record<string, unknown>)['notebook_path'];
        if (typeof raw !== 'string' || !raw) continue;
        const abs = path.isAbsolute(raw) ? raw : path.join(session.cwd, raw);
        const prev = touches.get(abs) ?? 0;
        touches.set(abs, Number.isNaN(ts) ? prev : Math.max(prev, ts));
      }
    }
  }
  const scan = { touches, lastHumanTs, dirs };
  touchCache.set(session.filePath, { key, scan });
  return scan;
}

async function subagentTranscripts(session: Session): Promise<string[]> {
  const dir = path.join(path.dirname(session.filePath), session.id, 'subagents');
  try {
    return (await fs.promises.readdir(dir))
      .filter(n => n.endsWith('.jsonl'))
      .sort()
      .map(n => path.join(dir, n));
  } catch {
    return [];
  }
}

/**
 * Working-tree changes for a repo: absolute path → status letter. Untracked entries come back at
 * directory granularity (`--untracked-files=normal`: a new folder is one `dir/` entry, skipped
 * here, its files are not walked), so new files at known levels show up without the full
 * untracked walk that makes `git status` slow in big repos. `statusFor` asks about specific paths.
 */
export async function gitStatus(repoRoot: string, nowMs = Date.now()): Promise<Map<string, FileStatus>> {
  const cached = statusCache.get(repoRoot);
  if (cached && nowMs - cached.at < STATUS_TTL_MS) return cached.map;
  const out = await run('git', ['-C', repoRoot, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  const map = parsePorcelain(out ?? '', repoRoot);
  statusCache.set(repoRoot, { at: nowMs, map });
  return map;
}

/** Status of specific paths, including untracked ones (pathspec-limited, so cheap). */
async function statusFor(repoRoot: string, absPaths: string[]): Promise<Map<string, FileStatus>> {
  const map = new Map<string, FileStatus>();
  for (let i = 0; i < absPaths.length; i += 200) {
    const chunk = absPaths.slice(i, i + 200);
    const out = await run('git', ['-C', repoRoot, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...chunk]);
    for (const [p, s] of parsePorcelain(out ?? '', repoRoot)) map.set(p, s);
  }
  return map;
}

function parsePorcelain(out: string, repoRoot: string): Map<string, FileStatus> {
  const map = new Map<string, FileStatus>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const x = entry[0] ?? ' ';
    const y = entry[1] ?? ' ';
    const rel = entry.slice(3);
    if (rel.endsWith('/')) continue; // an untracked directory, not a file
    let status: FileStatus;
    if (x === '?' || y === '?') status = '?';
    else if (x === 'R' || y === 'R') {
      status = 'R';
      i++; // rename: next NUL-separated field is the original path
    } else if (x === 'D' || y === 'D') status = 'D';
    else if (x === 'A' || y === 'A') status = 'A';
    else status = 'M';
    map.set(path.join(repoRoot, rel), status);
  }
  return map;
}

/**
 * Files for the review list: session touches merged with tracked changes of the containing repo.
 * A touched file outside the session's repo (or a session whose cwd is not a repo at all) is
 * resolved to its own repo, so it still gets a git status and a diff instead of a plain open.
 */
export async function changedFilesFor(session: Session): Promise<ChangedFile[]> {
  const [scan, status] = await Promise.all([touchedFiles(session), session.repoRoot ? gitStatus(session.repoRoot) : Promise.resolve(new Map<string, FileStatus>())]);
  const { touches } = scan;
  const since = session.lastUserTs ?? scan.lastHumanTs ?? 0;

  // Touched paths the tracked-only status did not mention: ask git about exactly those (finds
  // untracked files the session created), then stat whatever is still unknown.
  const unknown = [...touches.keys()].filter(p => !status.has(p));
  const home = session.repoRoot;
  const inHome = (p: string) => home !== null && p.startsWith(home + path.sep);
  const rootOf = new Map<string, string | null>();
  await Promise.all(
    unknown.map(async p => {
      if (inHome(p)) rootOf.set(p, home);
      else rootOf.set(p, await findRepoRoot(path.dirname(p), null));
    })
  );
  const byRoot = new Map<string, string[]>();
  for (const [p, r] of rootOf) if (r) byRoot.set(r, [...(byRoot.get(r) ?? []), p]);
  // Repos the session worked in through the shell (edits via sed/python/heredocs leave no
  // Edit/Write record): their tracked changes are the only evidence, so list them too.
  const workedIn = new Set<string>();
  await Promise.all([...scan.dirs].map(async d => {
    const r = await findRepoRoot(d, null);
    if (r && r !== home && !inHome(r)) workedIn.add(r);
  }));
  const extra = new Map<string, FileStatus>();
  const foreign = new Map<string, Map<string, FileStatus>>();
  await Promise.all([
    ...[...byRoot].map(async ([r, paths]) => {
      for (const [p, st] of await statusFor(r, paths)) extra.set(p, st);
      // The session clearly works in that repo too: its tracked changes belong on the list as well.
      if (r !== home) foreign.set(r, await gitStatus(r));
    }),
    ...[...workedIn].filter(r => !byRoot.has(r)).map(async r => foreign.set(r, await gitStatus(r)))
  ]);
  const toStat = unknown.filter(p => !extra.has(p));
  const present = new Map<string, boolean>();
  await Promise.all(toStat.map(async p => present.set(p, await exists(p))));

  const out: ChangedFile[] = [];
  const claudeDir = claudeHome();
  for (const [p, ts] of touches) {
    // Claude's own plans, memory notes and settings are not the user's work product; a copy the
    // session wrote into a repo is, and keeps its row.
    if (isUnder(claudeDir, p) && !rootOf.get(p)) continue;
    let st: FileStatus = status.get(p) ?? extra.get(p) ?? 'clean';
    if (st === 'clean' && present.get(p) === false) st = 'missing';
    const repoRoot = status.has(p) ? home : rootOf.get(p) ?? home;
    // Committed and unchanged since: there is no diff to review. Files outside any repo stay,
    // since "clean" is all git can say about them and they are still worth opening.
    if (st === 'clean' && repoRoot) continue;
    out.push({ path: p, repoRoot, status: st, thisTurn: ts >= since, lastEditTs: ts || null });
  }
  // Tracked working-tree changes the transcript did not record (e.g. made via Bash) still matter for review.
  for (const [p, st] of status) {
    if (touches.has(p)) continue;
    out.push({ path: p, repoRoot: home, status: st, thisTurn: false, lastEditTs: null });
  }
  for (const [r, map] of foreign) {
    for (const [p, st] of map) {
      if (touches.has(p)) continue;
      out.push({ path: p, repoRoot: r, status: st, thisTurn: false, lastEditTs: null });
    }
  }
  out.sort((a, b) => {
    if (a.thisTurn !== b.thisTurn) return a.thisTurn ? -1 : 1;
    if ((a.lastEditTs ?? 0) !== (b.lastEditTs ?? 0)) return (b.lastEditTs ?? 0) - (a.lastEditTs ?? 0);
    return a.path.localeCompare(b.path);
  });
  return out;
}

/**
 * Commits on the session's branch made while the session was active. Attribution is by time
 * window (first record → last activity, with slack), which is how Bash-driven `git commit`s show up.
 */
export async function sessionCommits(session: Session, nowMs = Date.now()): Promise<Commit[]> {
  if (!session.repoRoot || session.createdAt === null) return [];
  const from = session.createdAt - 5 * 60_000;
  const to = Math.min(nowMs, session.lastActivity + 10 * 60_000);
  const ref = session.gitBranch && session.gitBranch !== 'HEAD' ? session.gitBranch : 'HEAD';
  // `to` moves with the clock while a session is active; keep it out of the key so the TTL applies.
  const key = `${session.repoRoot}|${ref}|${from}`;
  const cached = commitCache.get(key);
  if (cached && nowMs - cached.at < COMMIT_TTL_MS) return cached.commits;
  const out = await run('git', [
    '-C',
    session.repoRoot,
    '--no-optional-locks',
    'log',
    ref,
    `--since=${new Date(from).toISOString()}`,
    `--until=${new Date(to).toISOString()}`,
    '--max-count=60',
    '--format=%H%x1f%h%x1f%s%x1f%ct%x1f%an%x1f%P'
  ]);
  const commits: Commit[] = [];
  for (const line of (out ?? '').split('\n')) {
    const [sha, short, subject, ct, author, parents] = line.split('\x1f');
    if (!sha || !short) continue;
    const parent = (parents ?? '').trim().split(' ')[0] || null;
    commits.push({ sha, short, subject: subject ?? '', ts: Number(ct) * 1000, author: author ?? '', repoRoot: session.repoRoot, parent });
  }
  commitCache.set(key, { at: nowMs, commits });
  return commits;
}

/** Files changed by one commit, as diffable entries (`sha^` ↔ `sha`). Immutable, so cached for good. */
export async function commitFiles(commit: Commit): Promise<ChangedFile[]> {
  const key = `${commit.repoRoot}|${commit.sha}`;
  const hit = commitFilesCache.get(key);
  if (hit) {
    commitFilesCache.delete(key); // refresh LRU position
    commitFilesCache.set(key, hit);
    return hit;
  }
  const out = await run('git', ['-C', commit.repoRoot, '--no-optional-locks', 'diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '--root', commit.sha]);
  if (out === null) return [];
  const files = parseNameStatus(out, commit.repoRoot, { from: `${commit.sha}^`, to: commit.sha });
  commitFilesCache.set(key, files);
  if (commitFilesCache.size > COMMIT_FILES_MAX) commitFilesCache.delete(commitFilesCache.keys().next().value as string);
  return files;
}

/** Default branch to compare against: origin/HEAD, else the first of main/master/dev/develop that exists. */
export async function defaultBase(repoRoot: string): Promise<string | null> {
  if (baseCache.has(repoRoot)) return baseCache.get(repoRoot) ?? null;
  let base: string | null = null;
  const sym = (await run('git', ['-C', repoRoot, '--no-optional-locks', 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']))?.trim();
  if (sym) base = sym;
  else {
    for (const c of ['origin/main', 'origin/master', 'origin/dev', 'origin/develop', 'main', 'master', 'dev', 'develop']) {
      if ((await run('git', ['-C', repoRoot, '--no-optional-locks', 'rev-parse', '--verify', '-q', c])) !== null) {
        base = c;
        break;
      }
    }
  }
  baseCache.set(repoRoot, base);
  return base;
}

/** Everything the branch changed relative to its merge-base with `base`, including uncommitted work. */
export async function branchFiles(repoRoot: string, base: string, nowMs = Date.now()): Promise<{ mergeBase: string; files: ChangedFile[] } | null> {
  const key = `${repoRoot}|${base}`;
  const cached = branchCache.get(key);
  if (cached && nowMs - cached.at < BRANCH_TTL_MS) return cached.result;
  const mb = (await run('git', ['-C', repoRoot, '--no-optional-locks', 'merge-base', base, 'HEAD']))?.trim();
  let result: { mergeBase: string; files: ChangedFile[] } | null = null;
  if (mb) {
    const out = await run('git', ['-C', repoRoot, '--no-optional-locks', 'diff', '--name-status', '-z', mb]);
    result = { mergeBase: mb, files: parseNameStatus(out ?? '', repoRoot, { from: mb, to: null }) };
  }
  branchCache.set(key, { at: nowMs, result });
  return result;
}

/** Branch-diff size if it was computed recently, without computing it. */
export function knownBranchCount(repoRoot: string, base: string): number | null {
  const cached = branchCache.get(`${repoRoot}|${base}`);
  return cached?.result ? cached.result.files.length : null;
}

/**
 * PR-style "Files changed" for a session: the union of what its commits touched plus uncommitted
 * work, merged with what the transcript says it edited (untracked files, turn marks). Built from
 * the per-commit lists rather than one range diff, so changes merged in from elsewhere during the
 * session do not count. Without commits this is the plain working-tree view; outside git it is the
 * touch list.
 */
export async function sessionFiles(session: Session, commits: Commit[]): Promise<{ from: string | null; files: ChangedFile[] }> {
  const working = await changedFilesFor(session);
  const repoRoot = session.repoRoot;
  if (!repoRoot) return { from: null, files: working };
  const inRepo = (p: string) => p.startsWith(repoRoot + path.sep);
  if (commits.length === 0) {
    for (const f of working) if (f.status !== 'clean' && f.status !== 'missing' && inRepo(f.path)) f.inWorkingTree = true;
    return { from: 'HEAD', files: working };
  }
  const lists = await Promise.all(commits.map(c => commitFiles(c)));
  const byPath = new Map<string, ChangedFile>();
  // Oldest first, so a file's diff starts at the parent of the first session commit that touched it.
  for (let i = commits.length - 1; i >= 0; i--) {
    const c = commits[i] as Commit;
    for (const f of lists[i] as ChangedFile[]) {
      const prev = byPath.get(f.path);
      if (!prev) {
        byPath.set(f.path, { ...f, thisTurn: false, refs: { from: c.parent ?? EMPTY_TREE, to: null }, inCommits: true, inWorkingTree: false });
      } else if (f.status === 'D') prev.status = 'D';
    }
  }
  for (const w of working) {
    const hit = byPath.get(w.path);
    if (hit) {
      hit.thisTurn = w.thisTurn;
      hit.lastEditTs = w.lastEditTs;
      hit.inWorkingTree = w.status !== 'clean' && w.status !== 'missing';
      if (w.status === 'D' || w.status === 'missing') hit.status = 'D';
      continue;
    }
    // Not in any session commit: uncommitted work in the repo, or a file outside it.
    const outside = !inRepo(w.path);
    if ((!outside || w.repoRoot) && (w.status === 'clean' || w.status === 'missing')) continue;
    byPath.set(w.path, { ...w, inCommits: false, inWorkingTree: w.repoRoot !== null && w.status !== 'clean' && w.status !== 'missing' });
  }
  const files = [...byPath.values()];
  files.sort((a, b) => {
    const ua = a.inWorkingTree ? 0 : 1;
    const ub = b.inWorkingTree ? 0 : 1;
    if (ua !== ub) return ua - ub;
    return a.path.localeCompare(b.path);
  });
  const oldest = commits[commits.length - 1] as Commit;
  return { from: oldest.parent ?? EMPTY_TREE, files };
}

/** One round trip for a session row: commits, comparison base, aggregate files. Never runs the branch diff. */
export async function sessionGroups(session: Session): Promise<SessionGroups> {
  const [commits, base] = await Promise.all([sessionCommits(session), session.repoRoot ? defaultBase(session.repoRoot) : Promise.resolve(null)]);
  const { from, files } = await sessionFiles(session, commits);
  const branchCount = session.repoRoot && base ? knownBranchCount(session.repoRoot, base) : null;
  return { commits, base, branchCount, from, files };
}

export function parseNameStatus(out: string, repoRoot: string, refs: { from: string | null; to: string | null }): ChangedFile[] {
  const parts = out.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const letter = code[0] ?? 'M';
    const rel = parts[++i];
    if (rel === undefined) break;
    let status: FileStatus = 'M';
    if (letter === 'A') status = 'A';
    else if (letter === 'D') status = 'D';
    else if (letter === 'R' || letter === 'C') {
      status = 'R';
      i++; // rename/copy carry a second path
      const newRel = parts[i];
      files.push({ path: path.join(repoRoot, newRel ?? rel), repoRoot, status, thisTurn: true, lastEditTs: null, refs });
      continue;
    }
    files.push({ path: path.join(repoRoot, rel), repoRoot, status, thisTurn: true, lastEditTs: null, refs });
  }
  return files;
}

/** Content of `rel` at `ref` in `repoRoot`; empty string when it does not exist there. */
export async function gitShow(repoRoot: string, ref: string, absPath: string): Promise<string> {
  const rel = path.relative(repoRoot, absPath).split(path.sep).join('/');
  return (await run('git', ['-C', repoRoot, '--no-optional-locks', 'show', `${ref}:${rel}`])) ?? '';
}

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise(resolve => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.stat(p);
    return true;
  } catch {
    return false;
  }
}
