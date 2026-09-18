import * as path from 'node:path';
import * as vscode from 'vscode';
import { getConfig } from './config';
import type { HubConfig } from './config';
import { emptySnapshot } from './model/types';
import type { QueueItem, Session, Snapshot } from './model/types';
import { displayName, fingerprint, primaryLive } from './model/types';
import { jobsDir, projectsDir, sessionsDir } from './paths';
import { ReviewedStore } from './state/reviewed-store';
import { deriveQueue } from './state/queue';
import { TerminalManager } from './terminals/manager';
import type { ItemContext, Node } from './views/nodes';
import { sessionOf } from './views/nodes';
import { fileTreeNodes } from './views/file-tree';
import type { Backend, PushMessage } from './backend/api';
import { LocalBackend } from './backend/local';
import { WorkerBackend } from './backend/worker-client';
import type { ChangedFile, SessionGroups } from './sources/changes';
import type { DirEntry, FsEntry } from './sources/repos';

const REGISTRY_DEBOUNCE_MS = 300;
const TRANSCRIPT_DEBOUNCE_MS = 2500;
const TIME_LABEL_REFRESH_MS = 60_000;
const IDLE_POLL_MS = 60_000;
/** Minimum gap between background re-validations of one expanded node. */
const REVALIDATE_MIN_MS = 5_000;
/** Host event-loop lag above which a refresh line reports it, and above which polling backs off. */
const LAG_REPORT_MS = 500;
const LAG_BACKOFF_MS = 1_000;
const POLL_BACKOFF_MAX = 6;
const DIR_TTL_MS = 60_000;

interface ChildCache {
  /** Freshness key: when the inputs this node depends on change, the entry is stale. */
  key: string;
  nodes: Node[];
  at: number;
  /** Node objects VS Code handed us for this id (one per tree); targeted change events need them. */
  parents: Node[];
  inflight: Promise<void> | null;
}

/** Central state: config, snapshot, refresh scheduling, watchers, terminals, children cache. */
export class Hub implements vscode.Disposable {
  readonly output: vscode.OutputChannel;
  readonly reviewed: ReviewedStore;
  readonly terminals: TerminalManager;
  private backend: Backend;
  private readonly emitter = new vscode.EventEmitter<Snapshot>();
  readonly onDidChange = this.emitter.event;
  private readonly nodeEmitter = new vscode.EventEmitter<Node>();
  /** Fired when one node's children/label changed; trees forward it as a targeted refresh. */
  readonly onDidChangeNode = this.nodeEmitter.event;
  private readonly subs: vscode.Disposable[] = [];
  private _config: HubConfig;
  private _snapshot: Snapshot = emptySnapshot();
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private debounceDue = 0;
  private poll: ReturnType<typeof setInterval> | undefined;
  private pollMs = 0;
  private refreshing = false;
  private dirty = false;
  private lastRefreshAt = 0;
  private lastFingerprint = '';
  private lastFiredAt = 0;
  private refreshCount = 0;
  private prevQueue: Map<string, QueueItem['kind']> | null = null;
  private watchers: vscode.Disposable[] = [];
  private readonly childCache = new Map<string, ChildCache>();
  /** Directory listings for browsing folders; cheap to recompute, so a short TTL. */
  private readonly dirCache = new Map<string, { at: number; dirs: DirEntry[] }>();
  private lagTimer: ReturnType<typeof setInterval> | undefined;
  private lagExpected = 0;
  private lagMax = 0;
  /** Poll interval multiplier while the extension host is starved (other extensions activating). */
  private pollBackoff = 1;
  /** File browser: show dotfiles, build output and `.gitignore`d entries. Persisted across windows. */
  private showHiddenFiles = false;
  /** Bumped whenever every directory listing should be re-read (toggle, force refresh). */
  private dirGeneration = 0;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('Claude Sessions');
    this._config = getConfig();
    this.reviewed = new ReviewedStore(context.globalState);
    this.showHiddenFiles = context.globalState.get<boolean>('sessionHub.showHidden', false);
    void vscode.commands.executeCommand('setContext', 'sessionHub.showHidden', this.showHiddenFiles);
    this.backend = this.createBackend();
    this.terminals = new TerminalManager({
      config: () => this._config,
      snapshot: () => this._snapshot,
      onBindingsChanged: () => {
        this.lastFiredAt = Date.now();
        this.emitter.fire(this._snapshot);
      },
      onSessionFocused: id => void this.onSessionFocused(id),
      processTree: () => this.backend.processTree(),
      log: msg => this.log(msg)
    });
    this.startLagMonitor();
    this.subs.push(
      this.terminals,
      this.emitter,
      this.nodeEmitter,
      this.output,
      vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration('sessionHub')) return;
        const prev = this._config;
        this._config = getConfig();
        if (prev.useWorker !== this._config.useWorker) {
          this.backend.dispose();
          this.backend = this.createBackend();
        } else {
          this.backend.invalidate();
        }
        this.childCache.clear();
        this.scheduleRefresh();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this._config = getConfig();
        this.scheduleRefresh();
      })
    );
    this.setupWatchers();
  }

  private createBackend(): Backend {
    const backend: Backend = this._config.useWorker
      ? new WorkerBackend(this.context.asAbsolutePath(path.join('dist', 'worker.js')), msg => this.log(msg))
      : new LocalBackend();
    if (!this._config.useWorker) this.log('scanning in the extension host (sessionHub.useWorker is off)');
    backend.onPush(msg => this.onPush(msg));
    return backend;
  }

  /**
   * A zero-work interval that drifts when the extension host's event loop is busy with other
   * extensions. The worker answers in milliseconds; when the log shows seconds, this says why.
   */
  private startLagMonitor(): void {
    this.lagExpected = Date.now() + 1000;
    this.lagTimer = setInterval(() => {
      const now = Date.now();
      this.lagMax = Math.max(this.lagMax, now - this.lagExpected);
      this.lagExpected = now + 1000;
    }, 1000);
  }

  /** Max loop lag since the last call (ms), then reset. */
  private takeLag(): number {
    const v = Math.max(0, Math.round(this.lagMax));
    this.lagMax = 0;
    return v;
  }

  get config(): HubConfig {
    return this._config;
  }
  get snapshot(): Snapshot {
    return this._snapshot;
  }
  /** Where scans run right now ('worker' or 'local'), for diagnostics. */
  get backendKind(): string {
    return this.backend.kind;
  }

  itemContext(): ItemContext {
    const real = this._snapshot.realRoots;
    return { roots: real.length ? [...real, ...this._config.roots] : this._config.roots, extensionUri: this.context.extensionUri, snapshot: this._snapshot };
  }

  log(msg: string): void {
    this.output.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
  }

  dispose(): void {
    if (this.debounce) clearTimeout(this.debounce);
    if (this.poll) clearInterval(this.poll);
    if (this.lagTimer) clearInterval(this.lagTimer);
    for (const w of this.watchers) w.dispose();
    for (const s of this.subs) s.dispose();
    this.backend.dispose();
  }

  /** Debounced refresh; a shorter pending delay wins over a longer one. */
  scheduleRefresh(delayMs = REGISTRY_DEBOUNCE_MS): void {
    const due = Date.now() + delayMs;
    if (this.debounce && this.debounceDue <= due) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounceDue = due;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.refresh();
    }, delayMs);
  }

  /** Serialized: one build at a time; requests during a build coalesce into one follow-up. */
  async refresh(force = false): Promise<void> {
    if (this.refreshing) {
      this.dirty = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.dirty = false;
        await this.refreshOnce(force);
      } while (this.dirty);
    } finally {
      this.refreshing = false;
    }
  }

  private async refreshOnce(force: boolean): Promise<void> {
    const t0 = performance.now();
    try {
      const snap = await this.backend.build({
        roots: this._config.roots,
        maxAgeDays: this._config.maxAgeDays,
        maxPerRepo: this._config.maxPerRepo,
        repoScanDepth: this._config.repoScanDepth,
        reviewedKeys: this.reviewed.keys(),
        expanded: this.expandedSessionIds()
      });
      const workerMs = Math.round(this.backend.lastMs);
      this._snapshot = snap;
      this.lastRefreshAt = Date.now();
      this.notifyTransitions(snap);
      const fp = fingerprint(snap);
      // Only re-render the trees when something visible changed (or once a minute for "2h ago" labels),
      // otherwise expanded nodes and in-flight children get thrown away on every transcript write.
      if (force || fp !== this.lastFingerprint || Date.now() - this.lastFiredAt > TIME_LABEL_REFRESH_MS) {
        this.lastFingerprint = fp;
        this.lastFiredAt = Date.now();
        this.emitter.fire(snap);
      }
      if (force) {
        this.childCache.clear();
        this.dirCache.clear();
        this.dirGeneration++;
      }
      this.revalidateStale();
      const tBuild = performance.now();
      await this.terminals.adopt();
      const lag = this.takeLag();
      this.pollBackoff = lag > LAG_BACKOFF_MS ? Math.min(this.pollBackoff * 2, POLL_BACKOFF_MAX) : 1;
      this.updatePoll();
      const total = performance.now() - t0;
      this.refreshCount++;
      if (total > 1000 || this.refreshCount <= 3) {
        const phases = Object.entries(snap.timings ?? {})
          .filter(([k]) => k !== 'worker')
          .map(([k, v]) => `${k}=${v}`)
          .join(' ');
        const lagNote = lag > LAG_REPORT_MS ? ` · host loop lag ${lag} ms` : '';
        this.log(
          `${total > 1000 ? 'slow ' : ''}refresh (${this.backend.kind}): total ${Math.round(total)} ms · build ${Math.round(tBuild - t0)} ms (worker ${workerMs} ms: ${phases}) · adopt ${Math.round(performance.now() - tBuild)} ms${lagNote}`
        );
      }
    } catch (err) {
      this.log(`refresh failed: ${(err as Error).stack ?? String(err)}`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Children of expandable nodes. Results are cached per node id with a freshness key; a cached
  // entry is returned immediately (even when stale) and refreshed in the background, after which
  // a targeted change event updates just that node. Re-rendering the whole tree therefore costs
  // memory lookups only, and the second expansion of anything is instant.
  // -------------------------------------------------------------------------------------------

  /** Children for any expandable node; called by both tree providers. */
  async children(node: Node): Promise<Node[]> {
    const id = nodeId(node);
    if (!id) return [];
    const key = this.freshnessKey(node);
    const cached = this.childCache.get(id);
    if (cached) {
      this.remember(cached, node);
      if (cached.key !== key) this.revalidate(id, node, key);
      return cached.nodes;
    }
    const t0 = performance.now();
    try {
      const nodes = await this.compute(node);
      const entry: ChildCache = { key, nodes, at: Date.now(), parents: [node], inflight: null };
      this.childCache.set(id, entry);
      const ms = Math.round(performance.now() - t0);
      if (ms > 5) this.log(`children ${id.slice(0, 40)}: ${nodes.length} in ${ms} ms (${this.backend.kind} ${Math.round(this.backend.lastMs)} ms)`);
      return nodes;
    } catch (err) {
      this.log(`children ${id} failed: ${(err as Error).message}`);
      return [{ kind: 'message', text: 'Could not read changes (see logs).' }];
    }
  }

  private remember(entry: ChildCache, parent: Node): void {
    if (!entry.parents.includes(parent)) {
      entry.parents.push(parent);
      if (entry.parents.length > 4) entry.parents.shift();
    }
  }

  private revalidate(id: string, node: Node, key: string): void {
    const entry = this.childCache.get(id);
    if (!entry || entry.inflight || Date.now() - entry.at < REVALIDATE_MIN_MS) return;
    entry.inflight = this.compute(node)
      .then(nodes => {
        const cur = this.childCache.get(id);
        if (!cur) return;
        cur.key = key;
        cur.at = Date.now();
        if (childrenFingerprint(nodes) === childrenFingerprint(cur.nodes)) return;
        cur.nodes = nodes;
        for (const p of cur.parents) this.nodeEmitter.fire(p);
      })
      .catch(err => this.log(`revalidate ${id} failed: ${(err as Error).message}`))
      .finally(() => {
        const cur = this.childCache.get(id);
        if (cur) cur.inflight = null;
      });
  }

  /** After a build: refresh cached children whose inputs changed, so expanded nodes track a busy session. */
  private revalidateStale(): void {
    for (const [id, entry] of this.childCache) {
      const parent = entry.parents[entry.parents.length - 1];
      if (!parent) continue;
      const node = this.rebind(parent);
      if (!node) continue;
      const key = this.freshnessKey(node);
      if (key !== entry.key) this.revalidate(id, node, key);
    }
  }

  /** Same node with the current snapshot's session object (nodes hold the session as of when they were built). */
  private rebind(node: Node): Node | null {
    const s = sessionOf(node);
    if (!s) return node;
    const fresh = this._snapshot.sessions.get(s.id);
    if (!fresh) return null;
    const live = primaryLive(this._snapshot.live.get(s.id));
    switch (node.kind) {
      case 'session':
        return { ...node, session: fresh, live };
      case 'live':
        return live ? { ...node, session: fresh, live } : null;
      case 'queue':
        return { ...node, item: { ...node.item, session: fresh, live } };
      default:
        return node;
    }
  }

  private freshnessKey(node: Node): string {
    const s = sessionOf(node) ?? this._snapshot.sessions.get((node as { sessionId?: string }).sessionId ?? '') ?? null;
    const sessionKey = s ? this.sessionKey(s) : '-';
    switch (node.kind) {
      case 'commit':
        return 'immutable';
      case 'commitsGroup':
        return node.commits.map(c => c.sha).join(',');
      case 'browseGroup':
      case 'fsDir':
        // Any session working under this root may have created files: its activity re-reads the listing.
        return `${this.showHiddenFiles ? 1 : 0}:${this.dirGeneration}:${this.rootActivity(node.root)}`;
      default:
        return sessionKey;
    }
  }

  /** Newest activity of any session running under `root`. */
  private rootActivity(root: string): number {
    let max = 0;
    for (const s of this._snapshot.sessions.values()) {
      const cwd = s.cwdReal ?? s.cwd;
      if ((cwd === root || cwd.startsWith(root + path.sep)) && s.lastActivity > max) max = s.lastActivity;
    }
    return max;
  }

  private async compute(node: Node): Promise<Node[]> {
    switch (node.kind) {
      case 'queue':
      case 'live':
      case 'session':
        return this.sessionChildren(node);
      case 'commitsGroup':
        return node.commits.map(commit => ({ kind: 'commit', sessionId: node.sessionId, commit }) as Node);
      case 'commit': {
        const files = await this.backend.commitFiles(node.commit);
        return files.map(file => ({ kind: 'file', file, sessionId: node.sessionId }) as Node);
      }
      case 'branchGroup': {
        const br = await this.backend.branchFiles(node.repoRoot, node.base);
        const files = br?.files ?? [];
        if (node.count !== files.length) {
          node.count = files.length; // the header shows the count once known
          this.nodeEmitter.fire(node);
        }
        return files.map(file => ({ kind: 'file', file, sessionId: node.sessionId }) as Node);
      }
      case 'filesGroup': {
        const session = this._snapshot.sessions.get(node.sessionId);
        if (!session) return [];
        const g = await this.backend.sessionGroups(session);
        if (node.count !== g.files.length) {
          node.count = g.files.length;
          this.nodeEmitter.fire(node);
        }
        return fileNodesOf(g.files, node.sessionId);
      }
      case 'browseGroup':
        return this.entryNodes(node.root, node);
      case 'fsDir':
        return this.entryNodes(node.path, node);
      default:
        return [];
    }
  }

  private async entryNodes(dir: string, parent: Extract<Node, { kind: 'browseGroup' | 'fsDir' }>): Promise<Node[]> {
    const entries = await this.backend.listEntries(dir, parent.repoRoot, this.showHiddenFiles);
    if (entries.length === 0) return [{ kind: 'message', text: 'Empty folder' }];
    return entries.map(e => this.entryNode(e, parent));
  }

  private entryNode(e: FsEntry, parent: Extract<Node, { kind: 'browseGroup' | 'fsDir' }>): Node {
    if (e.kind === 'dir') {
      // A nested repo has its own .gitignore rules; from there down it is the repo root.
      const repoRoot = e.isGit ? e.path : parent.repoRoot;
      return { kind: 'fsDir', sessionId: parent.sessionId, root: parent.root, repoRoot, path: e.path, ignored: e.ignored };
    }
    return { kind: 'fsFile', sessionId: parent.sessionId, root: parent.root, path: e.path, ignored: e.ignored };
  }

  get showHidden(): boolean {
    return this.showHiddenFiles;
  }

  /** Flip the file browser between hiding and showing ignored entries; every listing is re-read. */
  async setShowHidden(value: boolean): Promise<void> {
    if (value === this.showHiddenFiles) return;
    this.showHiddenFiles = value;
    this.dirGeneration++;
    await this.context.globalState.update('sessionHub.showHidden', value);
    void vscode.commands.executeCommand('setContext', 'sessionHub.showHidden', value);
    this.dropDirCaches();
    this.emitter.fire(this._snapshot);
  }

  /** Forget one directory's listing (after an upload) and redraw the rows that show it. */
  invalidateDir(dir: string): void {
    this.dirCache.delete(dir);
    const parents: Node[] = [];
    for (const id of [`fsdir:${dir}`, `browse:${dir}`]) {
      const entry = this.childCache.get(id);
      if (!entry) continue;
      this.childCache.delete(id);
      parents.push(...entry.parents);
    }
    for (const p of parents) this.nodeEmitter.fire(p);
  }

  private dropDirCaches(): void {
    this.dirCache.clear();
    for (const id of [...this.childCache.keys()]) if (id.startsWith('fsdir:') || id.startsWith('browse:')) this.childCache.delete(id);
  }

  /**
   * A session reads like a pull request: "Files changed" (all commits plus uncommitted work) first,
   * then the commit list, then the whole branch against its base. One backend round trip; the
   * branch diff itself is only computed when that group is expanded.
   */
  private async sessionChildren(node: Node): Promise<Node[]> {
    const session = sessionOf(node);
    if (!session || !session.filePath) return [];
    const g = await this.backend.sessionGroups(session);
    return this.groupNodes(session, g, this.freshnessKey(node));
  }

  /** Group rows for a session, seeding the caches of every child level the groups already contain. */
  private groupNodes(session: Session, g: SessionGroups, key: string): Node[] {
    const out: Node[] = [];
    out.push({ kind: 'filesGroup', sessionId: session.id, count: g.files.length, commitCount: g.commits.length, from: g.from });
    if (session.repoRoot) out.push({ kind: 'commitsGroup', sessionId: session.id, commits: g.commits });
    if (session.repoRoot && g.base && session.gitBranch && session.gitBranch !== g.base.replace(/^origin\//, '') && session.gitBranch !== 'HEAD') {
      out.push({ kind: 'branchGroup', sessionId: session.id, repoRoot: session.repoRoot, base: g.base, count: g.branchCount });
    }
    const browseRoot = session.repoRoot ?? session.cwdReal ?? session.cwd;
    if (browseRoot) out.push({ kind: 'browseGroup', sessionId: session.id, root: browseRoot, repoRoot: session.repoRoot ?? null });
    this.seed(`files:${session.id}`, fileNodesOf(g.files, session.id), key);
    if (session.repoRoot) {
      this.seed(`commits:${session.id}`, g.commits.map(commit => ({ kind: 'commit', sessionId: session.id, commit }) as Node), g.commits.map(c => c.sha).join(','));
      for (const c of g.commits) if (c.files) this.seed(`commit:${session.id}:${c.sha}`, fileNodesOf(c.files, session.id), 'immutable');
    }
    if (!session.repoRoot && g.files.length === 0) {
      // Keep the browser: reading files matters even when nothing was changed.
      return [{ kind: 'message', text: 'No file changes recorded for this session.' }, ...out.filter(n => n.kind === 'browseGroup')];
    }
    return out;
  }

  /** Put children into the cache without a request; if they differ from what is shown, refresh that node. */
  private seed(id: string, nodes: Node[], key: string): void {
    const existing = this.childCache.get(id);
    if (!existing) {
      this.childCache.set(id, { key, nodes, at: Date.now(), parents: [], inflight: null });
      return;
    }
    existing.key = key;
    existing.at = Date.now();
    if (childrenFingerprint(nodes) === childrenFingerprint(existing.nodes)) return;
    existing.nodes = nodes;
    for (const p of existing.parents) {
      if (p.kind === 'filesGroup') p.count = nodes.length;
      this.nodeEmitter.fire(p);
    }
  }

  /**
   * Prefetched groups from the worker: the session's rows become a cache hit before the user
   * expands anything, so a click during an extension-host stall still answers instantly.
   */
  private onPush(msg: PushMessage): void {
    if (msg.push !== 'groups') return;
    const session = this._snapshot.sessions.get(msg.sessionId);
    if (!session) return;
    const key = this.sessionKey(session);
    const nodes = this.groupNodes(session, msg.groups, key);
    this.seed(`s:${session.id}`, nodes, key);
  }

  /** Session ids whose rows are (or were) expanded: the worker prefetches these right after live ones. */
  private expandedSessionIds(): string[] {
    const out: string[] = [];
    for (const [id, entry] of this.childCache) if (id.startsWith('s:') && entry.parents.length) out.push(id.slice(2));
    return out;
  }

  private sessionKey(s: Session): string {
    return `${s.id}:${s.lastActivity}:${primaryLive(this._snapshot.live.get(s.id))?.status ?? '-'}`;
  }

  /** Subdirectories of `dir` (worker-listed, cached for a minute) so every folder under the roots can be browsed. */
  async listDirs(dir: string): Promise<DirEntry[]> {
    const hit = this.dirCache.get(dir);
    if (hit && Date.now() - hit.at < DIR_TTL_MS) return hit.dirs;
    const dirs = await this.backend.listDirs(dir);
    this.dirCache.set(dir, { at: Date.now(), dirs });
    return dirs;
  }

  /** Groups for commands (Open all diffs, summary). */
  sessionGroups(session: Session): Promise<SessionGroups> {
    return this.backend.sessionGroups(session);
  }
  gitShow(repoRoot: string, ref: string, absPath: string): Promise<string> {
    return this.backend.gitShow(repoRoot, ref, absPath);
  }

  /** Focus handler: clear the review item for the session the user just looked at. */
  async onSessionFocused(sessionId: string): Promise<void> {
    if (!this._config.clearReviewOnFocus) return;
    const item = this._snapshot.queue.find(q => q.kind === 'review' && q.sessionId === sessionId);
    if (item?.reviewKey) await this.markReviewed(item.reviewKey);
  }

  /**
   * Marking reviewed must feel instant: re-derive the queue from the snapshot we already have and
   * re-render right away, then persist and rebuild in the background. Waiting for a worker round
   * trip here meant the row lingered for as long as the extension host was busy.
   */
  async markReviewed(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const persist = this.reviewed.add(...keys); // the in-memory set is updated before the write is awaited
    this.applyReviewedLocally();
    void this.refresh();
    await persist;
  }

  private applyReviewedLocally(): void {
    const snap = this._snapshot;
    const q = deriveQueue({
      live: snap.live,
      sessions: snap.sessions,
      jobs: snap.jobs,
      reviewed: new Set(this.reviewed.keys()),
      jobMaxAgeMs: this._config.maxAgeDays * 86_400_000,
      now: Date.now()
    });
    snap.queue = q.queue;
    snap.counts = q.counts;
    this.notifyTransitions(snap);
    this.lastFingerprint = fingerprint(snap);
    this.lastFiredAt = Date.now();
    this.emitter.fire(snap);
  }

  private setupWatchers(): void {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    const mk = (base: string, glob: string, onChange: (uri: vscode.Uri, kind: 'create' | 'change' | 'delete') => void) => {
      try {
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), glob));
        w.onDidCreate(u => onChange(u, 'create'));
        w.onDidChange(u => onChange(u, 'change'));
        w.onDidDelete(u => onChange(u, 'delete'));
        this.watchers.push(w);
      } catch (err) {
        this.log(`watcher on ${base}/${glob} failed: ${(err as Error).message}`);
      }
    };
    // Registry: files appear/vanish per process, and `status` flips inside them.
    mk(sessionsDir(), '*.json', () => this.scheduleRefresh(REGISTRY_DEBOUNCE_MS));
    // Transcripts change on every tool call of a busy session; status flips arrive via the registry,
    // so transcript-triggered refreshes only need to be timely, not instant.
    mk(projectsDir(), '**/*.jsonl', (u, kind) => {
      if (kind === 'delete') this.backend.forget(u.fsPath);
      else this.backend.markDirty(u.fsPath);
      this.scheduleRefresh(TRANSCRIPT_DEBOUNCE_MS);
    });
    mk(jobsDir(), '*/state.json', () => this.scheduleRefresh(REGISTRY_DEBOUNCE_MS));
  }

  private updatePoll(): void {
    const want = this._snapshot.live.size > 0 ? this._config.pollIntervalMs * this.pollBackoff : IDLE_POLL_MS;
    if (this.poll && this.pollMs === want) return;
    if (this.poll) clearInterval(this.poll);
    this.pollMs = want;
    this.poll = setInterval(() => {
      // Watchers usually beat the poll; skip when a refresh happened recently.
      if (Date.now() - this.lastRefreshAt >= want * 0.8) void this.refresh();
    }, want);
  }

  /** Toasts on transitions into needsInput / review (seeded on the first snapshot). */
  private notifyTransitions(snap: Snapshot): void {
    const cur = new Map<string, QueueItem['kind']>();
    for (const q of snap.queue) cur.set(q.reviewKey ?? `${q.sessionId}:${q.kind}`, q.kind);
    const prev = this.prevQueue;
    this.prevQueue = cur;
    if (!prev || !this._config.notificationsEnabled) return;
    for (const q of snap.queue) {
      if (q.kind === 'running') continue;
      const key = q.reviewKey ?? `${q.sessionId}:${q.kind}`;
      if (prev.has(key)) continue;
      const name = q.job && !q.session ? q.job.name ?? q.job.short : displayName(q.session, q.live);
      const msg = q.kind === 'needsInput' ? `Claude needs input: ${name} (${q.reason})` : `Claude finished: ${name}`;
      void vscode.window.showInformationMessage(msg, 'Open').then(choice => {
        if (choice !== 'Open') return;
        if (q.job && !q.live) this.terminals.attachJob(q.job);
        else void this.terminals.focus(q.sessionId);
      });
    }
  }
}

/** Cache id of an expandable node (mirrors the TreeItem ids in views/nodes.ts). */
export function nodeId(node: Node): string | null {
  switch (node.kind) {
    case 'queue':
      return node.item.job && !node.item.session ? null : `s:${node.item.sessionId}`;
    case 'live':
      return `s:${node.sessionId}`;
    case 'session':
      return `s:${node.session.id}`;
    case 'commitsGroup':
      return `commits:${node.sessionId}`;
    case 'commit':
      return `commit:${node.sessionId}:${node.commit.sha}`;
    case 'branchGroup':
      return `branch:${node.sessionId}`;
    case 'filesGroup':
      return `files:${node.sessionId}`;
    case 'browseGroup':
      return `browse:${node.root}`;
    case 'fsDir':
      return `fsdir:${node.path}`;
    default:
      return null;
  }
}

/** Cheap equality for "did the children change" after a background re-validation. */
export function childrenFingerprint(nodes: Node[]): string {
  return nodes
    .map(n => {
      switch (n.kind) {
        case 'file':
          return `f:${n.file.path}:${n.file.status}:${n.file.thisTurn ? 1 : 0}:${n.file.refs?.from ?? ''}:${n.file.inCommits ? 1 : 0}${n.file.inWorkingTree ? 1 : 0}`;
        case 'commitsGroup':
          return `c:${n.commits.map(c => c.sha).join(',')}`;
        case 'branchGroup':
          return `b:${n.base}:${n.count ?? '?'}`;
        case 'filesGroup':
          return `w:${n.count}:${n.commitCount}:${n.from ?? ''}`;
        case 'commit':
          return `k:${n.commit.sha}`;
        case 'fileFolder':
          return `d:${n.rel}:${n.count}:${childrenFingerprint(n.children)}`;
        case 'browseGroup':
          return `g:${n.root}`;
        case 'fsDir':
          return `e:${n.path}:d:${n.ignored ? 1 : 0}`;
        case 'fsFile':
          return `e:${n.path}:f:${n.ignored ? 1 : 0}`;
        case 'message':
          return `m:${n.text}`;
        default:
          return n.kind;
      }
    })
    .join('|');
}

function fileNodesOf(files: ChangedFile[], sessionId: string): Node[] {
  return fileTreeNodes(files, sessionId);
}

export function transcriptPathFor(sessionId: string, cwd: string): string {
  // Only used as a fallback for sessions with no scanned transcript; Claude encodes cwd by replacing separators.
  const encoded = cwd.replace(/[\\/:]/g, '-');
  return path.join(projectsDir(), encoded, `${sessionId}.jsonl`);
}
