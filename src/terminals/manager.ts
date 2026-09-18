import * as vscode from 'vscode';
import type { HubConfig } from '../config';
import type { BgJob, LiveSession, Session, Snapshot } from '../model/types';
import { displayName, primaryLive } from '../model/types';
import { descendants } from './adopt';

interface Binding {
  sessionId: string | null;
  /** Claude pid this terminal hosts, when known (adoption / registry match). */
  pid: number | null;
  cwd: string;
  createdAt: number;
  /** Extension-created terminal waiting for its registry entry to appear. */
  pending: boolean;
  /** The bound session left the registry while the shell stayed open. */
  stale: boolean;
}

export interface TerminalManagerDeps {
  config: () => HubConfig;
  snapshot: () => Snapshot;
  onBindingsChanged: () => void;
  onSessionFocused: (sessionId: string) => void;
  /** `ps` runs in the scanner worker so the host never waits on a spawn. */
  processTree: () => Promise<Map<number, number[]>>;
  log: (msg: string) => void;
}

/**
 * Owns the sessionId ↔ Terminal mapping. Creates terminals that run
 * `claude --resume <id>` in the session's cwd, and adopts terminals the user
 * started by hand by walking the process tree.
 */
export class TerminalManager implements vscode.Disposable {
  private readonly bindings = new Map<vscode.Terminal, Binding>();
  private readonly bySession = new Map<string, vscode.Terminal>();
  private readonly subs: vscode.Disposable[] = [];
  private adopting = false;
  /** A terminal's shell pid never changes; asking the renderer each refresh is a round trip we can skip. */
  private readonly shellPids = new WeakMap<vscode.Terminal, Promise<number | undefined>>();
  private lastSignature = '';

  constructor(private readonly deps: TerminalManagerDeps) {
    this.subs.push(
      vscode.window.onDidCloseTerminal(t => this.unbind(t)),
      vscode.window.onDidChangeActiveTerminal(t => {
        const b = t ? this.bindings.get(t) : undefined;
        if (b?.sessionId) this.deps.onSessionFocused(b.sessionId);
      }),
      vscode.window.onDidOpenTerminal(() => void this.adopt())
    );
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }

  terminalFor(sessionId: string): vscode.Terminal | undefined {
    const t = this.bySession.get(sessionId);
    return t && t.exitStatus === undefined ? t : undefined;
  }

  sessionOf(terminal: vscode.Terminal | undefined): string | null {
    return terminal ? this.bindings.get(terminal)?.sessionId ?? null : null;
  }

  activeSessionId(): string | null {
    return this.sessionOf(vscode.window.activeTerminal);
  }

  /** Focus the terminal hosting `sessionId`, creating one (and resuming) when needed. */
  async focus(sessionId: string): Promise<void> {
    const snap = this.deps.snapshot();
    const session = snap.sessions.get(sessionId) ?? null;
    const live = primaryLive(snap.live.get(sessionId));
    const existing = this.terminalFor(sessionId);
    if (existing) {
      const b = this.bindings.get(existing);
      existing.show(false);
      if (b?.stale && !live) {
        // The claude process exited but the shell is still there: resume in place.
        existing.sendText(this.resumeCommand(sessionId), true);
        b.stale = false;
        b.pending = true;
      }
      this.deps.onSessionFocused(sessionId);
      return;
    }
    const cwd = session?.cwdReal ?? session?.cwd ?? live?.cwd;
    if (!cwd) {
      void vscode.window.showWarningMessage('Session has no recorded working directory.');
      return;
    }
    if (live && live.kind === 'interactive') {
      const choice = await vscode.window.showWarningMessage(
        `"${displayName(session, live)}" is already running in another terminal (pid ${live.pid}) that this window does not own. Resuming here opens a second copy of the conversation.`,
        { modal: false },
        'Resume here anyway'
      );
      if (choice !== 'Resume here anyway') return;
    }
    const term = this.create(displayName(session, live, sessionId), cwd, this.resumeCommand(sessionId), sessionId);
    term.show(false);
  }

  /** Start a brand-new session in `cwd`; the terminal is bound once the registry shows it. */
  startNew(cwd: string, name?: string): vscode.Terminal {
    const cfg = this.deps.config();
    const parts = [cfg.claudePath];
    if (name) parts.push('-n', shellQuote(name));
    if (cfg.extraResumeArgs) parts.push(cfg.extraResumeArgs);
    const term = this.create(name ?? `claude · ${basename(cwd)}`, cwd, parts.join(' '), null);
    term.show(false);
    return term;
  }

  attachJob(job: BgJob): void {
    const cfg = this.deps.config();
    const sid = job.sessionId;
    const existing = sid ? this.terminalFor(sid) : undefined;
    if (existing) {
      existing.show(false);
      return;
    }
    const term = this.create(job.name ?? job.short, job.cwd ?? process.env['HOME'] ?? '/', `${cfg.claudePath} attach ${job.short}`, sid);
    term.show(false);
  }

  runInNewTerminal(cwd: string, command: string, name: string): void {
    const term = vscode.window.createTerminal({ name, cwd: vscode.Uri.file(cwd), iconPath: new vscode.ThemeIcon('terminal') });
    term.show(false);
    term.sendText(command, true);
  }

  /** Ordered list of live interactive session ids (queue order, then idle by recency). */
  orderedLive(): string[] {
    const snap = this.deps.snapshot();
    const seen = new Set<string>();
    const out: string[] = [];
    for (const q of snap.queue) {
      if (q.live && q.live.kind === 'interactive' && !seen.has(q.sessionId)) {
        seen.add(q.sessionId);
        out.push(q.sessionId);
      }
    }
    const rest: Array<[string, LiveSession]> = [];
    for (const [id, list] of snap.live) {
      const l = primaryLive(list);
      if (l && l.kind === 'interactive' && !seen.has(id)) rest.push([id, l]);
    }
    rest.sort((a, b) => b[1].statusUpdatedAt - a[1].statusUpdatedAt);
    for (const [id] of rest) out.push(id);
    return out;
  }

  /**
   * Bind terminals to registry entries: extension-created pending terminals and
   * user-started ones alike, by matching claude pids found under each shell pid.
   */
  async adopt(): Promise<void> {
    if (this.adopting) return;
    this.adopting = true;
    try {
      const snap = this.deps.snapshot();
      const cfg = this.deps.config();
      const livePids = new Map<number, LiveSession>();
      for (const list of snap.live.values()) for (const l of list) livePids.set(l.pid, l);

      // Mark bindings whose session vanished as stale (keep the terminal usable).
      for (const [term, b] of this.bindings) {
        if (b.sessionId && !snap.live.has(b.sessionId) && !b.pending) {
          if (!b.stale) {
            b.stale = true;
            this.deps.log(`session ${b.sessionId.slice(0, 8)} left the registry; terminal "${term.name}" marked stale`);
          }
        } else if (b.sessionId && snap.live.has(b.sessionId)) {
          b.stale = false;
        }
      }

      const candidates = vscode.window.terminals.filter(t => {
        if (t.exitStatus !== undefined) return false;
        const b = this.bindings.get(t);
        if (!b) return cfg.adoptExternalTerminals;
        return b.pending || b.stale || b.sessionId === null;
      });
      if (candidates.length === 0 || livePids.size === 0) return;

      // Same terminals, same claude processes as last time: nothing new to match.
      const pids = await Promise.all(candidates.map(t => this.shellPidOf(t)));
      const signature = `${pids.filter(Boolean).sort().join(',')}|${[...livePids.keys()].sort().join(',')}`;
      if (signature === this.lastSignature) return;
      this.lastSignature = signature;

      const tree = await this.deps.processTree();
      let changed = false;
      for (let i = 0; i < candidates.length; i++) {
        const term = candidates[i] as vscode.Terminal;
        const shellPid = pids[i];
        if (!shellPid) continue;
        const desc = descendants(tree, shellPid);
        let match: LiveSession | null = null;
        for (const pid of desc) {
          const l = livePids.get(pid);
          if (l) {
            match = l;
            break;
          }
        }
        if (!match) continue;
        if (this.bind(term, match, shellPid)) changed = true;
      }
      if (changed) this.deps.onBindingsChanged();
    } finally {
      this.adopting = false;
    }
  }

  private shellPidOf(term: vscode.Terminal): Promise<number | undefined> {
    let p = this.shellPids.get(term);
    if (!p) {
      p = Promise.resolve(term.processId).catch(() => undefined);
      this.shellPids.set(term, p);
    }
    return p;
  }

  private bind(term: vscode.Terminal, live: LiveSession, _shellPid: number): boolean {
    const prev = this.bindings.get(term);
    if (prev?.sessionId === live.sessionId && !prev.pending && !prev.stale) return false;
    if (prev?.sessionId && prev.sessionId !== live.sessionId) this.bySession.delete(prev.sessionId);
    const other = this.bySession.get(live.sessionId);
    if (other && other !== term && other.exitStatus === undefined) {
      // Two terminals host the same session id: the newest binding wins for focus.
      const ob = this.bindings.get(other);
      if (ob) ob.sessionId = null;
    }
    this.bindings.set(term, {
      sessionId: live.sessionId,
      pid: live.pid,
      cwd: prev?.cwd ?? live.cwd,
      createdAt: prev?.createdAt ?? Date.now(),
      pending: false,
      stale: false
    });
    this.bySession.set(live.sessionId, term);
    this.deps.log(`bound terminal "${term.name}" → ${live.sessionId.slice(0, 8)} (pid ${live.pid})`);
    return true;
  }

  private create(name: string, cwd: string, command: string, sessionId: string | null): vscode.Terminal {
    const cfg = this.deps.config();
    const location = cfg.terminalLocation === 'editor' ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel;
    const term = vscode.window.createTerminal({
      name: truncateName(name),
      cwd: vscode.Uri.file(cwd),
      iconPath: new vscode.ThemeIcon('sparkle'),
      location,
      isTransient: true
    });
    this.bindings.set(term, { sessionId, pid: null, cwd, createdAt: Date.now(), pending: true, stale: false });
    if (sessionId) this.bySession.set(sessionId, term);
    term.sendText(command, true);
    this.deps.onBindingsChanged();
    return term;
  }

  private resumeCommand(sessionId: string): string {
    const cfg = this.deps.config();
    const parts = [cfg.claudePath, '--resume', sessionId];
    if (cfg.extraResumeArgs) parts.push(cfg.extraResumeArgs);
    return parts.join(' ');
  }

  private unbind(term: vscode.Terminal): void {
    const b = this.bindings.get(term);
    if (!b) return;
    this.bindings.delete(term);
    if (b.sessionId && this.bySession.get(b.sessionId) === term) this.bySession.delete(b.sessionId);
    this.deps.onBindingsChanged();
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}
function truncateName(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 40 ? t.slice(0, 39) + '…' : t;
}
export type { Session };
