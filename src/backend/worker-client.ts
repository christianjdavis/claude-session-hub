import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Session, Snapshot } from '../model/types';
import type { ChangedFile, Commit, SessionGroups } from '../sources/changes';
import type { DirEntry, FsEntry } from '../sources/repos';
import type { Backend, BackendMethod, BuildOptions, PushMessage, RpcRequest, RpcResponse } from './api';
import { LocalBackend } from './local';

const CALL_TIMEOUT_MS = 30_000;
const RESTART_BACKOFF_MS = [200, 1_000, 5_000];
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES_IN_WINDOW = 3;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Runs the LocalBackend in a forked Node process. A child has its own event loop and libuv
 * thread pool, so our file reads and git calls never wait behind other extensions. If the child
 * keeps dying we fall back to running in-process rather than showing an empty tree.
 */
export class WorkerBackend implements Backend {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private crashes: number[] = [];
  private fallback: LocalBackend | null = null;
  private disposed = false;
  private pushCb: ((msg: PushMessage) => void) | null = null;
  lastMs = 0;

  constructor(
    private readonly scriptPath: string,
    private readonly log: (msg: string) => void
  ) {}

  get kind(): 'local' | 'worker' {
    return this.fallback ? 'local' : 'worker';
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  build(opts: BuildOptions): Promise<Snapshot> {
    return this.call<Snapshot>('build', [opts]);
  }
  markDirty(filePath: string): void {
    this.notify('markDirty', [filePath]);
  }
  forget(filePath: string): void {
    this.notify('forget', [filePath]);
  }
  invalidate(): void {
    this.notify('invalidate', []);
  }
  sessionGroups(session: Session): Promise<SessionGroups> {
    return this.call('sessionGroups', [session]);
  }
  commitFiles(commit: Commit): Promise<ChangedFile[]> {
    return this.call('commitFiles', [commit]);
  }
  branchFiles(repoRoot: string, base: string): Promise<{ mergeBase: string; files: ChangedFile[] } | null> {
    return this.call('branchFiles', [repoRoot, base]);
  }
  gitShow(repoRoot: string, ref: string, absPath: string): Promise<string> {
    return this.call('gitShow', [repoRoot, ref, absPath]);
  }
  processTree(): Promise<Map<number, number[]>> {
    return this.call('processTree', []);
  }
  listDirs(dir: string): Promise<DirEntry[]> {
    return this.call('listDirs', [dir]);
  }
  listEntries(dir: string, repoRoot: string | null, showHidden: boolean): Promise<FsEntry[]> {
    return this.call('listEntries', [dir, repoRoot, showHidden]);
  }
  onPush(cb: (msg: PushMessage) => void): void {
    this.pushCb = cb;
    this.fallback?.onPush(cb);
  }

  dispose(): void {
    this.disposed = true;
    this.failAll(new Error('backend disposed'));
    this.child?.kill();
    this.child = null;
  }

  private async call<T>(method: BackendMethod, args: unknown[]): Promise<T> {
    if (this.fallback) return this.callLocal<T>(method, args);
    await this.ensureStarted();
    if (this.fallback) return this.callLocal<T>(method, args);
    const child = this.child;
    if (!child) throw new Error('worker not running');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`worker call ${method} timed out after ${CALL_TIMEOUT_MS} ms`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve: v => resolve(v as T), reject, timer });
      child.send({ id, method, args } satisfies RpcRequest, err => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private async callLocal<T>(method: BackendMethod, args: unknown[]): Promise<T> {
    const fb = this.fallback as LocalBackend;
    const result = await (fb as unknown as Record<string, (...a: unknown[]) => Promise<T>>)[method]!(...args);
    this.lastMs = fb.lastMs;
    return result;
  }

  private notify(method: BackendMethod, args: unknown[]): void {
    if (this.fallback) {
      (this.fallback as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(...args);
      return;
    }
    // Only forward when the worker is up; a fresh worker rebuilds its index on the first build anyway.
    if (this.child?.connected) this.child.send({ id: 0, method, args, oneWay: true } satisfies RpcRequest, () => undefined);
  }

  private ensureStarted(): Promise<void> {
    if (this.child?.connected) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async start(): Promise<void> {
    if (this.disposed) throw new Error('backend disposed');
    const attempt = this.crashes.length;
    const delay = RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length - 1)] ?? 0;
    if (attempt > 0) await new Promise(r => setTimeout(r, delay));

    const child = fork(this.scriptPath, [], {
      serialization: 'advanced', // keeps Map/Set inside Snapshot intact
      execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    this.child = child;
    child.stdout?.on('data', (d: Buffer) => this.log(`worker: ${String(d).trimEnd()}`));
    child.stderr?.on('data', (d: Buffer) => this.log(`worker stderr: ${String(d).trimEnd()}`));
    child.on('message', (msg: RpcResponse | PushMessage) => this.onMessage(msg));
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
    child.on('error', err => this.log(`worker error: ${err.message}`));

    // Wait for the ready message (id 0) or an early exit.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker did not start within 10 s')), 10_000);
      const onReady = (msg: RpcResponse) => {
        if (msg.id === 0 && msg.ok) {
          clearTimeout(timer);
          child.off('message', onReady);
          resolve();
        }
      };
      child.on('message', onReady);
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('worker exited during startup'));
      });
    }).catch(err => {
      if (this.child === child) this.child = null;
      if (!this.fallback) throw err;
    });
    if (this.child === child) this.log(`worker started (pid ${child.pid})`);
  }

  private onMessage(msg: RpcResponse | PushMessage): void {
    if (!msg || typeof msg.id !== 'number') return;
    if ('push' in msg) {
      this.pushCb?.(msg);
      return;
    }
    if (msg.id === 0) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (typeof msg.ms === 'number') this.lastMs = msg.ms;
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child === child) this.child = null;
    if (this.disposed) return;
    const now = Date.now();
    this.crashes = this.crashes.filter(t => now - t < CRASH_WINDOW_MS);
    this.crashes.push(now);
    this.log(`worker exited (code ${code ?? '-'}, signal ${signal ?? '-'}); ${this.pending.size} call(s) failed`);
    this.failAll(new Error('worker exited'));
    if (this.crashes.length >= MAX_CRASHES_IN_WINDOW) {
      this.log(`worker crashed ${this.crashes.length} times in a minute; running scans in the extension host instead`);
      this.fallback = new LocalBackend();
      if (this.pushCb) this.fallback.onPush(this.pushCb);
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
