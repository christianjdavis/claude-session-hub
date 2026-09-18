import * as path from 'node:path';
import type { Session, Snapshot } from '../model/types';
import { emptySnapshot, primaryLive } from '../model/types';
import { projectsDir } from '../paths';
import { branchFiles, commitFiles, gitShow, invalidateAll, invalidateRepo, sessionGroups } from '../sources/changes';
import type { ChangedFile, Commit, SessionGroups } from '../sources/changes';
import { processTree } from '../sources/process-tree';
import { clearRepoCache, listDirs, listEntries } from '../sources/repos';
import type { DirEntry, FsEntry } from '../sources/repos';
import { TranscriptScanner } from '../sources/transcripts';
import { SessionStore } from '../state/store';
import type { BuildOptions } from '../state/store';
import type { Backend, PushMessage } from './api';

/** Sessions prefetched after each build: live first, then expanded, then most recent. */
const PREFETCH_MAX = 40;
const PREFETCH_CONCURRENCY = 2;

/** In-process implementation; runs inside the worker, and in the extension host as a fallback. */
export class LocalBackend implements Backend {
  readonly kind = 'local' as const;
  lastMs = 0;
  private readonly scanner = new TranscriptScanner();
  private readonly store = new SessionStore(this.scanner);
  private last: Snapshot = emptySnapshot();
  private pushCb: ((msg: PushMessage) => void) | null = null;
  /** sessionId → state key the last push was computed for; unchanged state means nothing to recompute. */
  private readonly pushed = new Map<string, string>();
  private generation = 0;
  private prefetching = false;

  async build(opts: BuildOptions): Promise<Snapshot> {
    const t0 = performance.now();
    this.last = await this.store.build(opts);
    this.lastMs = performance.now() - t0;
    if (this.last.timings) this.last.timings['worker'] = Math.round(this.lastMs);
    if (this.pushCb) void this.prefetch(this.last, opts.expanded ?? []);
    return this.last;
  }

  markDirty(filePath: string): void {
    const parent = path.dirname(filePath);
    if (path.dirname(parent) === projectsDir()) {
      // A session transcript proper (<projects>/<encoded-cwd>/<id>.jsonl).
      this.scanner.markDirty(filePath);
      const s = this.sessionFor(filePath);
      if (s?.repoRoot) invalidateRepo(s.repoRoot);
      return;
    }
    // Subagent transcript (<projects>/<encoded-cwd>/<id>/subagents/agent-*.jsonl): it is not a
    // session of its own, but its edits belong to the parent, whose repo caches go stale.
    const m = /^(.*)\/([^/]+)\/subagents\/[^/]+\.jsonl$/.exec(filePath);
    if (m) {
      const s = this.sessionFor(path.join(m[1] as string, `${m[2]}.jsonl`));
      if (s?.repoRoot) invalidateRepo(s.repoRoot);
    }
  }

  forget(filePath: string): void {
    this.scanner.forget(filePath);
  }

  invalidate(): void {
    this.scanner.invalidateIndex();
    clearRepoCache();
    invalidateAll();
    this.pushed.clear();
  }

  sessionGroups(session: Session): Promise<SessionGroups> {
    return this.timed(() => sessionGroups(session));
  }
  commitFiles(commit: Commit): Promise<ChangedFile[]> {
    return this.timed(() => commitFiles(commit));
  }
  branchFiles(repoRoot: string, base: string): Promise<{ mergeBase: string; files: ChangedFile[] } | null> {
    return this.timed(() => branchFiles(repoRoot, base));
  }
  gitShow(repoRoot: string, ref: string, absPath: string): Promise<string> {
    return this.timed(() => gitShow(repoRoot, ref, absPath));
  }
  processTree(): Promise<Map<number, number[]>> {
    return this.timed(() => processTree());
  }
  listDirs(dir: string): Promise<DirEntry[]> {
    return this.timed(() => listDirs(dir));
  }
  listEntries(dir: string, repoRoot: string | null, showHidden: boolean): Promise<FsEntry[]> {
    return this.timed(() => listEntries(dir, repoRoot, showHidden));
  }
  onPush(cb: (msg: PushMessage) => void): void {
    this.pushCb = cb;
  }
  dispose(): void {
    this.pushCb = null;
    this.generation++;
  }

  private async timed<T>(fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.lastMs = performance.now() - t0;
    }
  }

  /**
   * Compute groups (and commit file lists) for the sessions most likely to be expanded and push
   * them to the host, so a click there is a cache hit instead of a round trip. A newer build
   * abandons whatever is left of the previous queue.
   */
  private async prefetch(snap: Snapshot, expanded: string[]): Promise<void> {
    const gen = ++this.generation;
    if (this.prefetching) return; // the running pass re-reads `this.last` per item and stops on generation change
    this.prefetching = true;
    try {
      const queue = this.prefetchOrder(snap, expanded);
      const workers: Promise<void>[] = [];
      for (let w = 0; w < PREFETCH_CONCURRENCY; w++) {
        workers.push(
          (async () => {
            while (queue.length && gen === this.generation) {
              const id = queue.shift() as string;
              const session = this.last.sessions.get(id);
              if (!session?.filePath) continue;
              const key = stateKey(this.last, session);
              if (this.pushed.get(id) === key) continue;
              try {
                const groups = await sessionGroups(session);
                for (const c of groups.commits) c.files = await commitFiles(c);
                if (gen !== this.generation) return;
                this.pushed.set(id, key);
                this.pushCb?.({ id: 0, push: 'groups', sessionId: id, groups });
              } catch {
                /* a missing repo or transcript: nothing to push */
              }
            }
          })()
        );
      }
      await Promise.all(workers);
    } finally {
      this.prefetching = false;
      // A build arrived while we were busy: run again for the newest snapshot.
      if (gen !== this.generation && this.pushCb) void this.prefetch(this.last, expanded);
    }
  }

  private prefetchOrder(snap: Snapshot, expanded: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (id: string) => {
      if (seen.has(id) || out.length >= PREFETCH_MAX) return;
      seen.add(id);
      out.push(id);
    };
    for (const id of snap.live.keys()) add(id);
    for (const id of expanded) add(id);
    const recent = [...snap.repos.flatMap(r => r.sessions), ...snap.other].sort((a, b) => b.lastActivity - a.lastActivity);
    for (const s of recent) add(s.id);
    return out;
  }

  private sessionFor(filePath: string): Session | undefined {
    for (const s of this.last.sessions.values()) if (s.filePath === filePath) return s;
    return undefined;
  }
}

/** What the pushed groups depend on; the host derives the same key for its cache. */
export function stateKey(snap: Snapshot, s: Session): string {
  return `${s.lastActivity}:${primaryLive(snap.live.get(s.id))?.status ?? '-'}`;
}
