import assert from 'node:assert/strict';
import { displayName, primaryLive } from '../src/model/types';
import type { LiveSession, Session } from '../src/model/types';
import { deriveQueue, turnCompleted } from '../src/state/queue';
import { MemoryStore, ReviewedStore } from '../src/state/reviewed-store';
import { formatRelativeTime, truncate } from '../src/format';
import { isUnder, relToRoots } from '../src/paths';
import { EMPTY_TREE, invalidateRepo, parseNameStatus, sessionCommits, sessionFiles } from '../src/sources/changes';
import type { PushMessage } from '../src/backend/api';
import { fileTreeNodes } from '../src/views/file-tree';
import { listEntries } from '../src/sources/repos';
import { uploadTargets } from '../src/fs/upload-targets';
import type { ChangedFile } from '../src/sources/changes';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { WorkerBackend } from '../src/backend/worker-client';
import * as os from 'node:os';
import * as path from 'node:path';

function live(p: Partial<LiveSession>): LiveSession {
  return {
    pid: 1,
    sessionId: 's1',
    cwd: '/r/a',
    kind: 'interactive',
    name: null,
    nameSource: null,
    status: 'idle',
    waitingFor: null,
    startedAt: 1000,
    statusUpdatedAt: 5000,
    updatedAt: 5000,
    version: null,
    formerNames: [],
    registryPath: '',
    ...p
  };
}
function session(p: Partial<Session>): Session {
  return {
    id: 's1',
    filePath: '',
    cwd: '/r/a',
    cwdReal: '/r/a',
    gitBranch: null,
    aiTitle: null,
    lastPrompt: null,
    agentName: null,
    firstMessage: null,
    createdAt: null,
    lastActivity: 0,
    lastUserTs: null,
    lastEndTurnTs: null,
    lastAssistantText: null,
    pendingQuestion: false,
    prLink: null,
    repoRoot: null,
    inWorkspace: true,
    ...p
  };
}

let passed = 0;
const pending: Promise<void>[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  pending.push(
    Promise.resolve()
      .then(fn)
      .then(() => {
        passed++;
        console.log(`ok   ${name}`);
      })
      .catch(err => {
        console.error(`FAIL ${name}\n`, err);
        process.exitCode = 1;
      })
  );
}

test('waiting → needsInput', () => {
  const l = live({ status: 'waiting', waitingFor: 'dialog open' });
  const r = deriveQueue({ live: new Map([['s1', [l]]]), sessions: new Map(), jobs: [], reviewed: new Set<string>(), jobMaxAgeMs: 1e9, now: 9000 });
  assert.equal(r.queue.length, 1);
  assert.equal(r.queue[0]!.kind, 'needsInput');
  assert.equal(r.queue[0]!.reason, 'dialog open');
});

test('busy → running', () => {
  const l = live({ status: 'busy' });
  const r = deriveQueue({ live: new Map([['s1', [l]]]), sessions: new Map(), jobs: [], reviewed: new Set<string>(), jobMaxAgeMs: 1e9, now: 9000 });
  assert.equal(r.counts.running, 1);
});

test('idle after end_turn → review, cleared when reviewed', () => {
  const l = live({ status: 'idle' });
  const s = session({ lastUserTs: 2000, lastEndTurnTs: 4000 });
  const sessions = new Map([['s1', s]]);
  let r = deriveQueue({ live: new Map([['s1', [l]]]), sessions, jobs: [], reviewed: new Set<string>(), jobMaxAgeMs: 1e9, now: 9000 });
  assert.equal(r.queue[0]!.kind, 'review');
  assert.equal(r.queue[0]!.reviewKey, 's1:4000');
  r = deriveQueue({ live: new Map([['s1', [l]]]), sessions, jobs: [], reviewed: new Set(['s1:4000']), jobMaxAgeMs: 1e9, now: 9000 });
  assert.equal(r.queue.length, 0);
  assert.equal(r.counts.idle, 1);
});

test('idle with new prompt after end_turn is not review', () => {
  assert.equal(turnCompleted(session({ lastUserTs: 5000, lastEndTurnTs: 4000 }), live({})), false);
  assert.equal(turnCompleted(session({}), live({})), false);
});

test('pending AskUserQuestion while idle → needsInput', () => {
  const l = live({ status: 'idle' });
  const s = session({ pendingQuestion: true, lastUserTs: 1000, lastEndTurnTs: 2000 });
  const r = deriveQueue({ live: new Map([['s1', [l]]]), sessions: new Map([['s1', s]]), jobs: [], reviewed: new Set<string>(), jobMaxAgeMs: 1e9, now: 9000 });
  assert.equal(r.queue[0]!.kind, 'needsInput');
});

test('non-interactive live sessions are excluded from the queue', () => {
  const l = live({ status: 'busy', kind: 'bg' });
  const r = deriveQueue({ live: new Map([['s1', [l]]]), sessions: new Map(), jobs: [], reviewed: new Set<string>(), jobMaxAgeMs: 1e9, now: 9000 });
  assert.equal(r.queue.length, 0);
});

test('finished bg job → review once', () => {
  const job = { short: 'ab', sessionId: 'x', cwd: '/r', name: 'j', state: 'done', detail: null, tempo: null, updatedAt: 8000, live: null };
  let r = deriveQueue({ live: new Map(), sessions: new Map(), jobs: [job], reviewed: new Set<string>(), jobMaxAgeMs: 1e9, now: 9000 });
  assert.equal(r.queue[0]!.reviewKey, 'bg:ab:8000');
  r = deriveQueue({ live: new Map(), sessions: new Map(), jobs: [job], reviewed: new Set(['bg:ab:8000']), jobMaxAgeMs: 1e9, now: 9000 });
  assert.equal(r.queue.length, 0);
});

test('queue ordering: needsInput oldest first, review newest first', () => {
  const a = live({ sessionId: 'a', status: 'waiting', statusUpdatedAt: 3000 });
  const b = live({ sessionId: 'b', status: 'waiting', statusUpdatedAt: 1000 });
  const c = live({ sessionId: 'c', status: 'idle' });
  const d = live({ sessionId: 'd', status: 'idle' });
  const sessions = new Map([
    ['c', session({ id: 'c', lastUserTs: 1, lastEndTurnTs: 100 })],
    ['d', session({ id: 'd', lastUserTs: 1, lastEndTurnTs: 200 })]
  ]);
  const r = deriveQueue({ live: new Map([['a', [a]], ['b', [b]], ['c', [c]], ['d', [d]]]), sessions, jobs: [], reviewed: new Set<string>(), jobMaxAgeMs: 1e9, now: 9000 });
  assert.deepEqual(r.queue.map(q => q.sessionId), ['b', 'a', 'd', 'c']);
});

test('displayName precedence', () => {
  assert.equal(displayName(session({ aiTitle: 'T', firstMessage: 'F' }), live({ name: 'derived-x', nameSource: 'derived' })), 'T');
  assert.equal(displayName(session({ aiTitle: 'T' }), live({ name: 'user-name', nameSource: 'user' })), 'user-name');
  assert.equal(displayName(session({ firstMessage: 'F' }), null), 'F');
  assert.equal(displayName(null, null, 'abcdef123456'), 'abcdef12');
});

test('primaryLive picks newest', () => {
  const l1 = live({ pid: 1, updatedAt: 1 });
  const l2 = live({ pid: 2, updatedAt: 2 });
  assert.equal(primaryLive([l1, l2])!.pid, 2);
});

test('ReviewedStore persists and prunes', async () => {
  const mem = new MemoryStore();
  let now = 1_000_000_000_000;
  const rs = new ReviewedStore(mem, () => now);
  await rs.add('k1');
  assert.equal(rs.has('k1'), true);
  now += 31 * 86_400_000;
  const rs2 = new ReviewedStore(mem, () => now);
  assert.equal(rs2.has('k1'), false);
});

test('format + paths helpers', () => {
  assert.equal(formatRelativeTime(Date.now() - 3 * 3600_000), '3h ago');
  assert.equal(truncate('a  b   c', 3), 'a…');
  assert.equal(isUnder('/r', '/r/a/b'), true);
  assert.equal(isUnder('/r', '/rx/a'), false);
  assert.equal(relToRoots(['/r'], '/r/a/b'), 'a/b');
});

test('parseNameStatus handles add/modify/delete/rename', () => {
  const out = ['M', 'a.ts', 'A', 'b.ts', 'D', 'c.ts', 'R100', 'old.ts', 'new.ts', ''].join('\0');
  const files = parseNameStatus(out, '/repo', { from: 'x^', to: 'x' });
  assert.deepEqual(
    files.map(f => `${f.status} ${f.path}`),
    ['M /repo/a.ts', 'A /repo/b.ts', 'D /repo/c.ts', 'R /repo/new.ts']
  );
  assert.equal(files[0]!.refs?.to, 'x');
});

test('worker round trip: build + Map types survive IPC, oneWay calls, groups', async () => {
  const logs: string[] = [];
  const w = new WorkerBackend(path.join(__dirname, 'worker.js'), m => logs.push(m));
  try {
    const t0 = performance.now();
    const snap = await w.build({ roots: [path.join(os.homedir(), 'dev')], maxAgeDays: 14, maxPerRepo: 20, repoScanDepth: 4, reviewedKeys: [], expanded: [] });
    const cold = performance.now() - t0;
    assert.ok(snap.sessions instanceof Map, 'sessions is a Map');
    assert.ok(snap.live instanceof Map, 'live is a Map');
    assert.ok(Array.isArray(snap.realRoots) && snap.realRoots.length > 0, 'realRoots present');
    assert.ok(w.pid !== null, 'worker pid known');
    assert.ok(logs.some(l => l.includes('worker started')), 'start logged');
    w.markDirty('/nonexistent/x.jsonl'); // must not throw or reply
    w.invalidate();
    const t1 = performance.now();
    const snap2 = await w.build({ roots: [path.join(os.homedir(), 'dev')], maxAgeDays: 14, maxPerRepo: 20, repoScanDepth: 4, reviewedKeys: [] });
    const warm = performance.now() - t1;
    assert.equal(snap2.sessions.size, snap.sessions.size);
    const any = [...snap.sessions.values()].find(s => s.repoRoot && s.filePath);
    if (any) {
      const g1 = await w.sessionGroups(any);
      const t2 = performance.now();
      const g2 = await w.sessionGroups(any);
      const repeat = performance.now() - t2;
      assert.equal(g2.commits.length, g1.commits.length);
      assert.ok(Array.isArray(g1.files));
      assert.ok(repeat < 250, `repeat sessionGroups should be a cache hit, took ${repeat.toFixed(0)} ms`);
      console.log(`     worker: cold build ${cold.toFixed(0)} ms, warm ${warm.toFixed(0)} ms, sessionGroups repeat ${repeat.toFixed(0)} ms`);
    }
  } finally {
    w.dispose();
  }
});

test('sessionFiles: PR-style aggregate across commits + working tree, root commit falls back to the empty tree', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-git-')));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' }).toString();
  try {
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a1\n');
    git('add', '.');
    git('commit', '-q', '-m', 'one');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a2\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b1\n');
    git('add', '.');
    git('commit', '-q', '-m', 'two');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b2\n'); // uncommitted edit to a file the session committed
    fs.writeFileSync(path.join(dir, 'c.txt'), 'c\n'); // untracked and never touched via a tool: not the session's

    const now = Date.now();
    const s = session({ id: 'g1', filePath: '', cwd: dir, cwdReal: dir, repoRoot: dir, createdAt: now - 60_000, lastActivity: now });
    const commits = await sessionCommits(s, now);
    assert.equal(commits.length, 2);
    assert.equal(commits[commits.length - 1]!.subject, 'one');

    const agg = await sessionFiles(s, commits);
    assert.equal(agg.from, EMPTY_TREE, 'oldest commit is a root commit → empty tree');
    assert.deepEqual(
      agg.files.map(f => `${f.status} ${path.basename(f.path)} c=${f.inCommits ? 1 : 0} w=${f.inWorkingTree ? 1 : 0}`),
      ['A b.txt c=1 w=1', 'A a.txt c=1 w=0'],
      'uncommitted first, then by path; c.txt excluded'
    );
    assert.equal(agg.files[1]!.refs?.from, EMPTY_TREE, 'a.txt diffs from before the root commit');
    assert.equal(agg.files[0]!.refs?.from, commits[1]!.sha, 'b.txt diffs from the parent of the commit that added it');
    assert.equal(agg.files[0]!.refs?.to, null);

    // No session commits: plain working-tree view against HEAD.
    const wt = await sessionFiles(s, []);
    assert.equal(wt.from, 'HEAD');
    assert.deepEqual(wt.files.map(f => `${f.status} ${path.basename(f.path)} w=${f.inWorkingTree ? 1 : 0}`), ['M b.txt w=1']);

    // Commit the edit: the row flips to committed-only.
    git('add', '.');
    git('commit', '-q', '-m', 'three');
    invalidateRepo(dir);
    const agg2 = await sessionFiles(s, await sessionCommits(s, now + 1));
    const b = agg2.files.find(f => path.basename(f.path) === 'b.txt')!;
    assert.equal(b.inCommits, true);
    assert.equal(b.inWorkingTree, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('worker: processTree over IPC, prefetch pushes groups after a build', async () => {
  const logs: string[] = [];
  const w = new WorkerBackend(path.join(__dirname, 'worker.js'), m => logs.push(m));
  const pushes: PushMessage[] = [];
  let firstPush: (() => void) | null = null;
  const gotPush = new Promise<void>(r => (firstPush = r));
  w.onPush(m => {
    pushes.push(m);
    firstPush?.();
  });
  try {
    const tree = await w.processTree();
    assert.ok(tree instanceof Map, 'process tree is a Map');
    const here = await w.listEntries(path.join(__dirname, '..'), path.join(__dirname, '..'), false);
    assert.ok(here.some(e => e.kind === 'file' && e.name === 'package.json'), 'listEntries over IPC sees package.json');
    assert.ok(!here.some(e => e.name === 'node_modules' || e.name === 'dist'), 'listEntries hides SKIP + gitignored entries');
    assert.ok(tree.get(process.ppid)?.includes(process.pid), 'our own pid is listed under our parent');
    assert.ok(w.lastMs >= 0);
    const snap = await w.build({ roots: [path.join(os.homedir(), 'dev')], maxAgeDays: 14, maxPerRepo: 20, repoScanDepth: 4, reviewedKeys: [], expanded: [] });
    const withFiles = [...snap.sessions.values()].filter(s => s.filePath);
    if (withFiles.length === 0) {
      console.log('     (no sessions with transcripts: prefetch assertion skipped)');
      return;
    }
    await Promise.race([gotPush, new Promise((_, rej) => setTimeout(() => rej(new Error('no groups push within 8 s')), 8000))]);
    const p = pushes[0]!;
    assert.equal(p.push, 'groups');
    assert.ok(snap.sessions.has(p.sessionId), 'pushed session is in the snapshot');
    assert.ok(Array.isArray(p.groups.files) && Array.isArray(p.groups.commits));
    for (const c of p.groups.commits) assert.ok(Array.isArray(c.files), 'prefetched commits carry their file lists');
    console.log(`     prefetch: first push for ${p.sessionId.slice(0, 8)} — ${p.groups.files.length} files, ${p.groups.commits.length} commits`);
  } finally {
    w.dispose();
  }
});

test('fileTreeNodes: flat when short, folders with compressed chains when long', () => {
  const mk = (rel: string): ChangedFile => ({ path: `/repo/${rel}`, repoRoot: '/repo', status: 'M', thisTurn: false, lastEditTs: null });
  const short = fileTreeNodes([mk('a.ts'), mk('x/b.ts')], 's');
  assert.deepEqual(short.map(n => n.kind), ['file', 'file']);
  const many = [...Array.from({ length: 25 }, (_, i) => mk(`services/sites/amarillo/b2/tags/t${i}.json`)), mk('README.md'), mk('scripts/ci/check.py'), { ...mk('x'), path: `${os.homedir()}/.claude/plans/p.md`, repoRoot: '/repo' }];
  const tree = fileTreeNodes(many, 's');
  const labels = tree.map(n => (n.kind === 'fileFolder' ? `${n.label} (${n.count})` : n.kind === 'file' ? path.basename(n.file.path) : n.kind));
  assert.deepEqual(labels, ['scripts/ci (1)', 'services/sites/amarillo/b2/tags (25)', '~/.claude/plans (1)', 'README.md']);
  const tags = tree[1] as Extract<typeof tree[number], { kind: 'fileFolder' }>;
  assert.equal(tags.children.length, 25);
  assert.equal(tags.expanded, false);
  const single = fileTreeNodes(Array.from({ length: 21 }, (_, i) => mk(`only/dir/f${i}.ts`)), 's');
  assert.equal(single.length, 1);
  assert.equal((single[0] as Extract<typeof single[number], { kind: 'fileFolder' }>).expanded, true, 'a lone top-level folder opens itself');
});

void Promise.all(pending).then(() => {
  if (process.exitCode) console.log(`\n${passed} passed, some FAILED`);
  else console.log(`\n${passed} passed`);
});

test('listEntries: hides dotfiles, SKIP set and .gitignore matches; showHidden flags them; dirs first', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ls-')));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, '.gitignore'), '*.log\n');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, '.env'), 'x');
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'x');
  fs.writeFileSync(path.join(dir, 'b.log'), 'x');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  const shown = await listEntries(dir, dir, false);
  assert.deepEqual(shown.map(e => `${e.kind}:${e.name}`), ['dir:src', 'file:README.md']);
  const all = await listEntries(dir, dir, true);
  assert.deepEqual(all.map(e => `${e.kind}:${e.name}${e.ignored ? '*' : ''}`), ['dir:.git*', 'dir:node_modules*', 'dir:src', 'file:.env*', 'file:.gitignore*', 'file:b.log*', 'file:README.md']);
  // No repo root: dotfiles and SKIP still hidden, gitignore rules not consulted.
  const plain = await listEntries(dir, null, false);
  assert.deepEqual(plain.map(e => e.name), ['src', 'b.log', 'README.md']);
  assert.deepEqual(await listEntries(path.join(dir, 'does-not-exist'), null, false), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uploadTargets: base names into the folder, duplicates collapsed', () => {
  assert.deepEqual(uploadTargets(['/a/x.txt', '/b/y', '/c/x.txt'], '/dst'), [
    { src: '/a/x.txt', dst: '/dst/x.txt' },
    { src: '/b/y', dst: '/dst/y' }
  ]);
});
