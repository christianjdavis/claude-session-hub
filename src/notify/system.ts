import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { QueueItem } from '../model/types';
import { eventKey, notificationContent } from './content';

export type SystemNotifyMode = 'off' | 'needsInput' | 'all';

export interface SystemNotifierDeps {
  extensionId: string;
  mode: () => SystemNotifyMode;
  whenFocused: () => boolean;
  /** This window has a terminal bound to the session. */
  owns: (sessionId: string) => boolean;
  /** The session's terminal is the active terminal of this window. */
  isActiveHere: (sessionId: string) => boolean;
  /** The event is still in the current queue (the session still needs attention). */
  stillPending: (key: string) => boolean;
  log: (msg: string) => void;
}

/** Windows that do not own the session wait this long, so the owning window gets to send first. */
const NON_OWNER_DELAY_MS = 1500;
const CLAIM_DIR = path.join(os.tmpdir(), 'claude-session-hub-notify');
const CLAIM_TTL_MS = 24 * 3_600_000;
const NOTIFIER_CANDIDATES = ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier'];

/**
 * macOS Notification Center alerts for queue transitions.
 *
 * Every VS Code window runs its own copy of the extension and sees the same transitions, so exactly one
 * window sends each notification: the one whose terminal hosts the session (it claims first), otherwise
 * whichever window claims it after a short delay. Claims are exclusive-create files shared by all windows.
 *
 * Clicking routes back to the sending window: `asExternalUri` stamps our `vscode://` link with this
 * window's id, VS Code delivers the link to that window's UriHandler and brings the window forward.
 */
export class SystemNotifier implements vscode.Disposable {
  private notifierPath: string | null | undefined;
  private warnedMissing = false;
  private warnedDenied = false;
  /** Sessions this window currently has a notification showing for (removed once handled). */
  private readonly shown = new Set<string>();
  /** Claimed events held back because you were looking at the session; sent if you look away while still pending. */
  private readonly deferred = new Map<string, QueueItem>();
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly deps: SystemNotifierDeps) {
    void this.sweepClaims();
    this.subs.push(
      vscode.window.onDidChangeWindowState(() => this.flushDeferred()),
      vscode.window.onDidChangeActiveTerminal(() => this.flushDeferred())
    );
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }

  private lookingAt(sessionId: string): boolean {
    return !this.deps.whenFocused() && vscode.window.state.focused && this.deps.isActiveHere(sessionId);
  }

  private flushDeferred(): void {
    for (const [key, q] of this.deferred) {
      if (!this.deps.stillPending(key)) {
        this.deferred.delete(key);
        continue;
      }
      if (this.lookingAt(q.sessionId)) continue;
      this.deferred.delete(key);
      this.deps.log(`notify: you looked away from ${q.sessionId.slice(0, 8)} while it still needs you`);
      void this.send(q, true);
    }
  }

  wants(q: QueueItem): boolean {
    if (process.platform !== 'darwin') return false;
    const mode = this.deps.mode();
    if (mode === 'off' || q.kind === 'running') return false;
    return mode === 'all' || q.kind === 'needsInput';
  }

  async notify(q: QueueItem): Promise<void> {
    if (!this.wants(q)) return;
    const owned = this.deps.owns(q.sessionId);
    if (!owned) await delay(NON_OWNER_DELAY_MS);
    const key = eventKey(q);
    if (!(await this.claim(key))) return;
    if (this.lookingAt(q.sessionId)) {
      this.deps.log(`notify: held ${q.kind} for ${q.sessionId.slice(0, 8)}: its terminal is active in the focused window`);
      this.deferred.set(key, q);
      return;
    }
    await this.send(q, owned);
  }

  private async send(q: QueueItem, owned: boolean): Promise<void> {
    const content = notificationContent(q);
    const params = new URLSearchParams({ session: q.sessionId });
    if (q.job && !q.live) params.set('job', q.job.short);
    const link = await vscode.env.asExternalUri(vscode.Uri.parse(`${vscode.env.uriScheme}://${this.deps.extensionId}/focus?${params.toString()}`));
    this.deps.log(`notify (${owned ? 'owner' : 'fallback'}): ${content.title} — ${content.subtitle} → ${link.toString(true)}`);

    const bin = await this.terminalNotifier();
    if (bin) {
      this.shown.add(q.sessionId);
      const code = await run(bin, [
        '-title', content.title,
        '-subtitle', escapeLeading(content.subtitle),
        '-message', escapeLeading(content.message),
        '-group', groupId(q.sessionId),
        '-open', link.toString(true),
        ...(q.kind === 'needsInput' ? ['-sound', 'default'] : [])
      ], this.deps.log);
      if (code === 3) this.warnDenied();
      return;
    }
    await run('osascript', ['-e', appleScript(content)], this.deps.log);
    this.warnMissing();
  }

  /** Withdraw this window's notification for a session that no longer needs attention. */
  clear(sessionId: string): void {
    if (!this.shown.delete(sessionId) || !this.notifierPath) return;
    void run(this.notifierPath, ['-remove', groupId(sessionId)], this.deps.log);
  }

  sessionsShown(): string[] {
    return [...this.shown];
  }

  private async terminalNotifier(): Promise<string | null> {
    if (this.notifierPath !== undefined) return this.notifierPath;
    const onPath = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean).map(d => path.join(d, 'terminal-notifier'));
    for (const p of [...NOTIFIER_CANDIDATES, ...onPath]) {
      try {
        await fs.promises.access(p, fs.constants.X_OK);
        return (this.notifierPath = p);
      } catch {
        // try the next one
      }
    }
    return (this.notifierPath = null);
  }

  private warnMissing(): void {
    if (this.warnedMissing) return;
    this.warnedMissing = true;
    void vscode.window
      .showInformationMessage('Claude Sessions: install terminal-notifier so clicking a notification opens its session (`brew install terminal-notifier`).', 'Copy command')
      .then(choice => {
        if (choice === 'Copy command') void vscode.env.clipboard.writeText('brew install terminal-notifier');
      });
  }

  /** terminal-notifier exits 3 when macOS has notifications turned off for it. */
  private warnDenied(): void {
    if (this.warnedDenied) return;
    this.warnedDenied = true;
    void vscode.window
      .showWarningMessage('Claude Sessions: macOS is blocking notifications from terminal-notifier. Allow them in System Settings → Notifications → terminal-notifier.', 'Open Notification Settings')
      .then(choice => {
        if (choice) void vscode.env.openExternal(vscode.Uri.parse('x-apple.systempreferences:com.apple.Notifications-Settings.extension'));
      });
  }

  /** Exclusive-create a file named after the event; only the first window to do so sends. */
  private async claim(key: string): Promise<boolean> {
    const file = path.join(CLAIM_DIR, createHash('sha1').update(key).digest('hex'));
    try {
      await fs.promises.mkdir(CLAIM_DIR, { recursive: true });
      const h = await fs.promises.open(file, 'wx');
      await h.close();
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') this.deps.log(`notify claim failed: ${String(e)}`);
      return false;
    }
  }

  private async sweepClaims(): Promise<void> {
    try {
      const now = Date.now();
      for (const name of await fs.promises.readdir(CLAIM_DIR)) {
        const p = path.join(CLAIM_DIR, name);
        const st = await fs.promises.stat(p).catch(() => null);
        if (st && now - st.mtimeMs > CLAIM_TTL_MS) await fs.promises.rm(p, { force: true });
      }
    } catch {
      // nothing to sweep yet
    }
  }
}

function groupId(sessionId: string): string {
  return `claude-session-hub:${sessionId}`;
}

/** terminal-notifier reads a value starting with `-` or `[` as an option; a leading backslash escapes it. */
function escapeLeading(s: string): string {
  return /^[-[]/.test(s) ? `\\${s}` : s;
}

function appleScript(c: { title: string; subtitle: string; message: string }): string {
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `display notification ${q(c.message)} with title ${q(c.title)} subtitle ${q(c.subtitle)}`;
}

/** Run a command; resolves with its exit code (0 on success, -1 when it could not run). */
function run(cmd: string, args: string[], log: (msg: string) => void): Promise<number> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 15_000 }, (err, _stdout, stderr) => {
      if (!err) return resolve(0);
      const code = typeof err.code === 'number' ? err.code : -1;
      log(`notify: ${path.basename(cmd)} exited ${code}: ${(String(stderr).trim() || err.message).slice(0, 300)}`);
      resolve(code);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
