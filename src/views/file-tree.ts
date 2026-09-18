import * as path from 'node:path';
import type { ChangedFile } from '../sources/changes';
import { INDEX_REF } from '../sources/changes';
import { shortenHomePath } from '../paths';
import type { Node, ScmGroupId } from './nodes';

/** Above this many files the list is grouped by folder, like a pull request's file tree. */
export const FOLDER_THRESHOLD = 20;

type FileNode = Extract<Node, { kind: 'file' }>;
type FolderNode = Extract<Node, { kind: 'fileFolder' }>;

interface Dir {
  name: string;
  dirs: Map<string, Dir>;
  files: ChangedFile[];
}

/**
 * File rows for a group: flat (with the directory in the description) when short, otherwise
 * nested folders with single-child chains compressed (`services/sites/amarillo/b2`). Files
 * outside the repo are grouped under their `~`-shortened directory.
 */
export function fileTreeNodes(files: ChangedFile[], sessionId: string, scope?: string): Node[] {
  if (files.length <= FOLDER_THRESHOLD) return files.map(file => ({ kind: 'file', file, sessionId }) as Node);
  const root: Dir = { name: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const base = f.repoRoot && f.path.startsWith(f.repoRoot + path.sep) ? f.repoRoot : null;
    const rel = base ? f.path.slice(base.length + 1) : shortenHomePath(f.path);
    const segs = rel.split('/');
    segs.pop();
    let cur = root;
    for (const seg of segs) {
      let next = cur.dirs.get(seg);
      if (!next) {
        next = { name: seg, dirs: new Map(), files: [] };
        cur.dirs.set(seg, next);
      }
      cur = next;
    }
    cur.files.push(f);
  }
  const out = emit(root, '', sessionId, scope);
  // One folder at the top and nothing beside it: open it, the user would click it anyway.
  if (out.length === 1 && out[0]?.kind === 'fileFolder') out[0].expanded = true;
  return out;
}

/**
 * The Source Control view's layout for a session's "Files changed": **Staged Changes** (HEAD ↔
 * index) above **Changes** (index ↔ working tree, untracked included), a file with edits on both
 * sides of the index appearing in both, then whatever the session committed and left alone. A
 * session outside git has nothing to stage, so its files stay a flat list.
 */
export function scmNodes(files: ChangedFile[], sessionId: string): Node[] {
  const staged: ChangedFile[] = [];
  const changes: ChangedFile[] = [];
  const committed: ChangedFile[] = [];
  const other: ChangedFile[] = [];
  for (const f of files) {
    if (f.staged) staged.push({ ...f, status: f.indexStatus ?? f.status, refs: { from: 'HEAD', to: INDEX_REF }, staged: true, unstaged: false });
    if (f.unstaged) changes.push({ ...f, status: f.worktreeStatus ?? f.status, refs: { from: INDEX_REF, to: null }, staged: false, unstaged: true });
    if (!f.staged && !f.unstaged) (f.inCommits ? committed : other).push(f);
  }
  if (!staged.length && !changes.length && !committed.length) return fileTreeNodes(other, sessionId);
  const group = (g: ScmGroupId, list: ChangedFile[]): Node[] => (list.length ? [{ kind: 'scmGroup', sessionId, group: g, files: list, children: fileTreeNodes(list, sessionId, g) }] : []);
  return [...group('staged', staged), ...group('changes', changes), ...group('committed', committed), ...group('other', other)];
}

function emit(dir: Dir, prefix: string, sessionId: string, scope?: string): Node[] {
  const folders: FolderNode[] = [];
  // Repo folders first, files outside the repo (`~/…`) last, otherwise alphabetical.
  const order = ([a]: [string, Dir], [b]: [string, Dir]) => Number(a.startsWith('~')) - Number(b.startsWith('~')) || a.localeCompare(b);
  for (const [, d] of [...dir.dirs].sort(order)) {
    // Compress chains of directories that contain nothing but one subdirectory.
    let label = d.name;
    let cur = d;
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      cur = cur.dirs.values().next().value as Dir;
      label = `${label}/${cur.name}`;
    }
    const rel = prefix ? `${prefix}/${label}` : label;
    const children = emit(cur, rel, sessionId, scope);
    folders.push({ kind: 'fileFolder', sessionId, label, rel, count: countFiles(cur), children, expanded: false, ...(scope ? { scope } : {}) });
  }
  const files: FileNode[] = [...dir.files].sort((a, b) => a.path.localeCompare(b.path)).map(file => ({ kind: 'file', file, sessionId, inFolder: true }));
  return [...folders, ...files];
}

function countFiles(d: Dir): number {
  let n = d.files.length;
  for (const sub of d.dirs.values()) n += countFiles(sub);
  return n;
}
