import type { Session, Snapshot } from '../model/types';
import type { ChangedFile, Commit, SessionGroups } from '../sources/changes';
import type { DirEntry, FsEntry } from '../sources/repos';
import type { BuildOptions } from '../state/store';

export type { BuildOptions };

/** Worker → host notification: prefetched groups for one session (no request behind it). */
export interface GroupsPush {
  id: 0;
  push: 'groups';
  sessionId: string;
  groups: SessionGroups;
}
export type PushMessage = GroupsPush;

/**
 * Everything that touches the file system or spawns processes. The extension host talks to one
 * of these; the default implementation lives in a separate worker process so its I/O never queues
 * behind other extensions' work in the shared libuv thread pool.
 */
export interface Backend {
  readonly kind: 'local' | 'worker';
  /** Time the last completed call spent inside the backend (ms), separate from host-side waiting. */
  readonly lastMs: number;
  build(opts: BuildOptions): Promise<Snapshot>;
  /** Watcher hooks: fire-and-forget. */
  markDirty(filePath: string): void;
  forget(filePath: string): void;
  invalidate(): void;
  sessionGroups(session: Session): Promise<SessionGroups>;
  commitFiles(commit: Commit): Promise<ChangedFile[]>;
  branchFiles(repoRoot: string, base: string): Promise<{ mergeBase: string; files: ChangedFile[] } | null>;
  gitShow(repoRoot: string, ref: string, absPath: string): Promise<string>;
  processTree(): Promise<Map<number, number[]>>;
  /** Subdirectories of a folder, for browsing to places no session has run yet. */
  listDirs(dir: string): Promise<DirEntry[]>;
  /** Full listing of a folder for the file browser; `repoRoot` enables `.gitignore` filtering. */
  listEntries(dir: string, repoRoot: string | null, showHidden: boolean): Promise<FsEntry[]>;
  /** Prefetched results arrive here after each build. */
  onPush(cb: (msg: PushMessage) => void): void;
  dispose(): void;
}

/** Methods callable over IPC; kept in one place so client and worker agree. */
export const BACKEND_METHODS = ['build', 'markDirty', 'forget', 'invalidate', 'sessionGroups', 'commitFiles', 'branchFiles', 'gitShow', 'processTree', 'listDirs', 'listEntries'] as const;
export type BackendMethod = (typeof BACKEND_METHODS)[number];

export interface RpcRequest {
  id: number;
  method: BackendMethod;
  args: unknown[];
  /** No reply expected. */
  oneWay?: boolean;
}
/** `ms`: time spent inside the worker, so the host can tell its own waiting apart from real work. */
export type RpcResponse = { id: number; ok: true; result: unknown; ms?: number } | { id: number; ok: false; error: string; ms?: number };
