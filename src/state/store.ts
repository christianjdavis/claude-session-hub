import * as path from 'node:path';
import { emptySnapshot } from '../model/types';
import type { LiveSession, Repo, Session, Snapshot } from '../model/types';
import { isUnder, normalizePath } from '../paths';
import { readJobs } from '../sources/jobs';
import { readRegistry } from '../sources/registry';
import { findRepoRoot, scanRepos } from '../sources/repos';
import { CONCURRENCY, mapLimit, TranscriptScanner } from '../sources/transcripts';
import type { TranscriptHead } from '../sources/transcripts';
import { deriveQueue } from './queue';

export interface BuildOptions {
  roots: string[];
  maxAgeDays: number;
  maxPerRepo: number;
  repoScanDepth: number;
  /** Review keys the user has already looked at (plain array: this crosses a process boundary). */
  reviewedKeys: string[];
  /** Sessions the user has expanded in a tree: prefetched first after live ones. */
  expanded?: string[];
  now?: number;
}

const REPO_SCAN_TTL_MS = 15 * 60 * 1000;

/**
 * Pure snapshot builder: merges the live registry, background jobs and transcripts
 * into one Snapshot. No VS Code dependency, so it can run from scripts/tests.
 */
export class SessionStore {
  private repoScan: { at: number; key: string; repos: Set<string> } | null = null;
  private inFlight: Promise<Snapshot> | null = null;
  private lastRealRoots: string[] = [];

  constructor(private readonly scanner: TranscriptScanner = new TranscriptScanner()) {}

  /** Coalesces concurrent callers onto one build. */
  build(opts: BuildOptions): Promise<Snapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.buildOnce(opts).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async buildOnce(opts: BuildOptions): Promise<Snapshot> {
    const now = opts.now ?? Date.now();
    const snap = emptySnapshot();
    snap.at = now;
    const timings: Record<string, number> = {};
    let mark = performance.now();
    const lap = (name: string) => {
      const t = performance.now();
      timings[name] = Math.round(t - mark);
      mark = t;
    };
    snap.timings = timings;
    const roots = opts.roots.map(normalizePath);
    const realRoots = await Promise.all(roots.map(r => this.scanner.realpath(r)));
    this.lastRealRoots = realRoots;
    snap.realRoots = realRoots;
    const allRoots = [...new Set([...roots, ...realRoots])];

    // Event-loop lag probe: how long a zero-delay timer waits tells us whether the extension host is contended.
    const lagStart = performance.now();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    timings['loopLag'] = Math.round(performance.now() - lagStart);
    mark = performance.now();
    const liveList = await readRegistry();
    lap('registry');
    const jobs = await readJobs();
    lap('jobs');
    for (const l of liveList) {
      if (!this.scanner.hasTranscript(l.sessionId)) this.scanner.markDirDirty(this.scanner.projectDirFor(l.cwd));
    }
    const transcripts = await this.scanner.listTranscripts();
    lap('list');

    for (const l of liveList) {
      const arr = snap.live.get(l.sessionId);
      if (arr) arr.push(l);
      else snap.live.set(l.sessionId, [l]);
    }
    for (const j of jobs) {
      if (j.sessionId) {
        const arr = snap.live.get(j.sessionId);
        if (arr && arr[0]) j.live = arr[0];
      }
    }
    snap.jobs = jobs;

    // Candidate transcripts: live ones always; historical ones only within maxAgeDays.
    const cutoff = now - opts.maxAgeDays * 86_400_000;
    const liveIds = new Set(snap.live.keys());
    const existing = new Set(transcripts.map(t => t.filePath));
    this.scanner.prune(existing);
    const candidates = transcripts.filter(t => liveIds.has(path.basename(t.filePath, '.jsonl')) || t.mtimeMs >= cutoff);

    const heads = (
      await mapLimit(candidates, CONCURRENCY, t => this.scanner.readHead(t.filePath, t.mtimeMs, t.size))
    ).filter((h): h is TranscriptHead => h !== null);

    lap('heads');
    const sessions = await mapLimit(heads, CONCURRENCY, h => this.toSession(h, allRoots, realRoots, liveIds.has(h.id)));
    for (const s of sessions) snap.sessions.set(s.id, s);
    lap('tails');

    // Live sessions with no transcript yet (brand new): synthesize a minimal record.
    for (const [id, list] of snap.live) {
      if (snap.sessions.has(id)) continue;
      const l = list[0] as LiveSession;
      snap.sessions.set(id, await this.synthesize(id, l, allRoots, realRoots));
    }

    snap.repos = await this.groupRepos(snap, allRoots, realRoots, opts, now);
    lap('repos');
    snap.other = [...snap.sessions.values()].filter(s => !s.inWorkspace).sort((a, b) => b.lastActivity - a.lastActivity);

    const q = deriveQueue({
      live: snap.live,
      sessions: snap.sessions,
      jobs: snap.jobs,
      reviewed: new Set(opts.reviewedKeys),
      jobMaxAgeMs: opts.maxAgeDays * 86_400_000,
      now
    });
    snap.queue = q.queue;
    snap.counts = q.counts;
    return snap;
  }

  private async toSession(h: TranscriptHead, roots: string[], realRoots: string[], isLive: boolean): Promise<Session> {
    const cwdReal = normalizePath(await this.scanner.realpath(h.cwd));
    const cwd = normalizePath(h.cwd);
    const inWorkspace = roots.some(r => isUnder(r, cwd) || isUnder(r, cwdReal));
    const stopAt = realRoots.find(r => isUnder(r, cwdReal)) ?? null;
    const repoRoot = await findRepoRoot(cwdReal, stopAt);
    const tail = await this.scanner.readTail(h.filePath, h.mtimeMs, h.size);
    return {
      id: h.id,
      filePath: h.filePath,
      cwd,
      cwdReal,
      gitBranch: tail?.gitBranch ?? h.gitBranch,
      aiTitle: tail?.aiTitle ?? h.headTitle,
      lastPrompt: tail?.lastPrompt ?? null,
      agentName: tail?.agentName ?? null,
      firstMessage: h.firstMessage,
      createdAt: h.createdAt,
      lastActivity: h.mtimeMs,
      lastUserTs: tail?.lastUserTs ?? null,
      lastEndTurnTs: tail?.lastEndTurnTs ?? null,
      lastAssistantText: tail?.lastAssistantText ?? null,
      pendingQuestion: isLive ? tail?.pendingQuestion ?? false : false,
      prLink: tail?.prLink ?? null,
      repoRoot,
      inWorkspace
    };
  }

  private async synthesize(id: string, l: LiveSession, roots: string[], realRoots: string[]): Promise<Session> {
    const cwdReal = normalizePath(await this.scanner.realpath(l.cwd));
    const cwd = normalizePath(l.cwd);
    const inWorkspace = roots.some(r => isUnder(r, cwd) || isUnder(r, cwdReal));
    const stopAt = realRoots.find(r => isUnder(r, cwdReal)) ?? null;
    return {
      id,
      filePath: '',
      cwd,
      cwdReal,
      gitBranch: null,
      aiTitle: null,
      lastPrompt: null,
      agentName: null,
      firstMessage: null,
      createdAt: l.startedAt,
      lastActivity: l.updatedAt,
      lastUserTs: null,
      lastEndTurnTs: null,
      lastAssistantText: null,
      pendingQuestion: false,
      prLink: null,
      repoRoot: await findRepoRoot(cwdReal, stopAt),
      inWorkspace
    };
  }

  private async groupRepos(snap: Snapshot, roots: string[], realRoots: string[], opts: BuildOptions, now: number): Promise<Repo[]> {
    const scanKey = realRoots.join('|') + ':' + opts.repoScanDepth;
    if (!this.repoScan || this.repoScan.key !== scanKey || now - this.repoScan.at > REPO_SCAN_TTL_MS) {
      this.repoScan = { at: now, key: scanKey, repos: await scanRepos(realRoots, opts.repoScanDepth) };
    }

    const byRoot = new Map<string, Repo>();
    const ensure = (root: string, isGit: boolean): Repo => {
      let r = byRoot.get(root);
      if (!r) {
        r = { root, label: path.basename(root), relPath: relTo(realRoots, root), isGit, sessions: [], liveCount: 0 };
        byRoot.set(root, r);
      }
      return r;
    };
    for (const root of this.repoScan.repos) ensure(normalizePath(root), true);

    for (const s of snap.sessions.values()) {
      if (!s.inWorkspace) continue;
      const root = s.repoRoot ?? topLevelUnder(realRoots, s.cwdReal) ?? s.cwdReal;
      const repo = ensure(root, s.repoRoot !== null);
      repo.sessions.push(s);
      if (snap.live.has(s.id)) repo.liveCount++;
    }

    const repos = [...byRoot.values()];
    for (const r of repos) {
      r.sessions.sort((a, b) => {
        const la = snap.live.has(a.id) ? 1 : 0;
        const lb = snap.live.has(b.id) ? 1 : 0;
        if (la !== lb) return lb - la;
        return b.lastActivity - a.lastActivity;
      });
      // Keep every live session; cap historical ones.
      let hist = 0;
      r.sessions = r.sessions.filter(s => snap.live.has(s.id) || hist++ < opts.maxPerRepo);
    }
    repos.sort((a, b) => {
      if (a.liveCount !== b.liveCount) return b.liveCount - a.liveCount;
      const ta = a.sessions[0]?.lastActivity ?? 0;
      const tb = b.sessions[0]?.lastActivity ?? 0;
      if (ta !== tb) return tb - ta;
      return a.relPath.localeCompare(b.relPath);
    });
    return repos;
  }

  get realRoots(): string[] {
    return this.lastRealRoots;
  }
}

function relTo(roots: string[], p: string): string {
  for (const r of roots) if (isUnder(r, p)) return path.relative(r, p) || path.basename(r);
  return p;
}

/** First path segment below the containing root, e.g. ~/dev/projects for ~/dev/projects/x/y. */
function topLevelUnder(roots: string[], p: string): string | null {
  for (const r of roots) {
    if (!isUnder(r, p)) continue;
    const rel = path.relative(r, p);
    if (!rel) return r;
    const first = rel.split(path.sep)[0];
    return first ? path.join(r, first) : r;
  }
  return null;
}
