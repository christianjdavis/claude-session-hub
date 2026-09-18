import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Hub } from '../hub';
import type { Repo, Session } from '../model/types';
import type { Node } from './nodes';
import { relToRoots } from '../paths';
import { branchGroupItem, commitItem, commitsGroupItem, browseGroupItem, filesGroupItem, fileFolderItem, fileItem, fsDirItem, fsFileItem, folderItem, liveFor, messageItem, repoItem, sectionItem, sessionItem } from './nodes';

interface FolderEntry {
  path: string;
  relPath: string;
  label: string;
  folders: Map<string, FolderEntry>;
  repos: Repo[];
  /** Sessions that ran in this directory itself (not in a git repo below it). */
  sessions: Session[];
  liveCount: number;
  sessionCount: number;
}

/** "All available" view: folder hierarchy under the roots → repos → sessions, plus sessions outside. */
export class ReposTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private index: Map<string, FolderEntry> = new Map();
  private indexedAt = -1;

  constructor(private readonly hub: Hub) {
    hub.onDidChange(() => this.emitter.fire(undefined));
    hub.onDidChangeNode(node => this.emitter.fire(node));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const ctx = this.hub.itemContext();
    switch (node.kind) {
      case 'folder':
        return folderItem(node, ctx);
      case 'repo':
        return repoItem(node, ctx);
      case 'session':
        return sessionItem(node, ctx);
      case 'file':
        return fileItem(node);
      case 'fileFolder':
        return fileFolderItem(node);
      case 'commitsGroup':
        return commitsGroupItem(node);
      case 'commit':
        return commitItem(node);
      case 'branchGroup':
        return branchGroupItem(node);
      case 'filesGroup':
        return filesGroupItem(node);
      case 'browseGroup':
        return browseGroupItem(node);
      case 'fsDir':
        return fsDirItem(node);
      case 'fsFile':
        return fsFileItem(node);
      case 'section':
        return sectionItem(node, true);
      case 'message':
        return messageItem(node.text);
      default:
        return messageItem('');
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const snap = this.hub.snapshot;
    this.ensureIndex();
    if (!node) {
      const roots = [...this.index.values()];
      let nodes: Node[];
      // One root: show its children directly; several: show each root as a folder.
      if (roots.length === 1) nodes = await this.folderChildren(roots[0] as FolderEntry);
      else nodes = roots.map(f => this.toFolderNode(f));
      if (nodes.length === 0) nodes.push({ kind: 'message', text: 'No repositories found under the configured roots.' });
      if (snap.other.length > 0) nodes.push({ kind: 'section', id: 'other', label: 'Outside workspace', count: snap.other.length });
      return nodes;
    }
    if (node.kind === 'folder') return this.folderChildren(this.lookup(node.path) ?? this.emptyEntry(node.path, node.relPath, node.label));
    if (node.kind === 'repo') {
      const sessions = node.repo.sessions.map(session => ({ kind: 'session', session, live: liveFor(snap, session.id) }) as Node);
      return [...sessions, { kind: 'browseGroup', sessionId: null, root: node.repo.root, repoRoot: node.repo.isGit ? node.repo.root : null }];
    }
    if (node.kind === 'fileFolder') return node.children;
    if (node.kind === 'session' || node.kind === 'commitsGroup' || node.kind === 'commit' || node.kind === 'branchGroup' || node.kind === 'filesGroup' || node.kind === 'browseGroup' || node.kind === 'fsDir') {
      return this.hub.children(node);
    }
    if (node.kind === 'section' && node.id === 'other') {
      return snap.other.slice(0, 50).map(session => ({ kind: 'session', session, live: liveFor(snap, session.id) }) as Node);
    }
    return [];
  }

  /** Repo row for a pinned path: the snapshot's entry when it has one, else a bare repo with no sessions. */
  repoNode(root: string): Node {
    this.ensureIndex();
    const repo = this.hub.snapshot.repos.find(r => r.root === root);
    if (repo) return { kind: 'repo', repo };
    return { kind: 'repo', repo: { root, label: path.basename(root), relPath: relToRoots(this.hub.itemContext().roots, root), isGit: true, sessions: [], liveCount: 0 } };
  }

  /** Folder row for a pinned path, with live/session counts when the index knows it. */
  folderNode(p: string): Node {
    this.ensureIndex();
    const entry = this.lookup(p);
    if (entry) return this.toFolderNode(entry);
    return { kind: 'folder', path: p, relPath: relToRoots(this.hub.itemContext().roots, p), label: path.basename(p), liveCount: 0, sessionCount: 0 };
  }

  private emptyEntry(p: string, relPath: string, label: string): FolderEntry {
    return { path: p, relPath, label, folders: new Map(), repos: [], sessions: [], liveCount: 0, sessionCount: 0 };
  }

  /**
   * Known folders/repos (those with sessions or found by the repo scan) merged with what is
   * actually on disk, so a session can be started in a directory nothing has run in yet.
   */
  private async folderChildren(entry: FolderEntry): Promise<Node[]> {
    const snap = this.hub.snapshot;
    const folders = new Map<string, Node>();
    const repos = new Map<string, Node>();
    for (const f of entry.folders.values()) folders.set(f.path, this.toFolderNode(f));
    for (const repo of entry.repos) repos.set(repo.root, { kind: 'repo', repo });
    for (const d of await this.hub.listDirs(entry.path)) {
      if (folders.has(d.path) || repos.has(d.path)) continue;
      if (d.isGit) repos.set(d.path, { kind: 'repo', repo: { root: d.path, label: d.name, relPath: path.join(entry.relPath, d.name), isGit: true, sessions: [], liveCount: 0 } });
      else folders.set(d.path, { kind: 'folder', path: d.path, relPath: path.join(entry.relPath, d.name), label: d.name, liveCount: 0, sessionCount: 0 });
    }
    const byLabel = (a: Node, b: Node) => labelOf(a).localeCompare(labelOf(b));
    const sessions = entry.sessions.map(session => ({ kind: 'session', session, live: liveFor(snap, session.id) }) as Node);
    const browse: Node = { kind: 'browseGroup', sessionId: null, root: entry.path, repoRoot: null };
    return [...[...folders.values()].sort(byLabel), ...[...repos.values()].sort(byLabel), ...sessions, browse];
  }

  private toFolderNode(f: FolderEntry): Node {
    return { kind: 'folder', path: f.path, relPath: f.relPath, label: f.label, liveCount: f.liveCount, sessionCount: f.sessionCount };
  }

  private lookup(p: string): FolderEntry | undefined {
    for (const root of this.index.values()) {
      if (root.path === p) return root;
      if (!p.startsWith(root.path + path.sep)) continue;
      let cur: FolderEntry | undefined = root;
      for (const seg of path.relative(root.path, p).split(path.sep)) {
        cur = cur?.folders.get(seg);
        if (!cur) return undefined;
      }
      return cur;
    }
    return undefined;
  }

  /** Rebuild the folder index whenever the snapshot changes. */
  private ensureIndex(): void {
    const snap = this.hub.snapshot;
    if (this.indexedAt === snap.at) return;
    this.indexedAt = snap.at;
    const roots = this.hub.itemContext().roots;
    const index = new Map<string, FolderEntry>();
    const mk = (p: string, relPath: string, label: string): FolderEntry => ({ path: p, relPath, label, folders: new Map(), repos: [], sessions: [], liveCount: 0, sessionCount: 0 });
    // Every root gets an entry even before any repo or session exists under it, so it can be browsed.
    for (const r of snap.realRoots.length ? snap.realRoots : roots) if (!index.has(r)) index.set(r, mk(r, '', path.basename(r)));
    for (const repo of snap.repos) {
      const root = roots.find(r => repo.root === r || repo.root.startsWith(r + path.sep));
      if (!root) continue;
      let entry = index.get(root);
      if (!entry) {
        entry = mk(root, '', path.basename(root));
        index.set(root, entry);
      }
      const segs = path.relative(root, repo.root).split(path.sep).filter(Boolean);
      const chain: FolderEntry[] = [entry];
      let cur = entry;
      // A git repo: all segments but the last are folders, the last is the repo row. A plain directory
      // sessions ran in (not a repo): every segment is a folder and the sessions hang off the last one,
      // so it never shows up as a second row with the same name as the folder.
      const folderSegs = repo.isGit ? segs.slice(0, -1) : segs;
      for (const seg of folderSegs) {
        let next = cur.folders.get(seg);
        if (!next) {
          next = mk(path.join(cur.path, seg), path.join(cur.relPath, seg), seg);
          cur.folders.set(seg, next);
        }
        cur = next;
        chain.push(cur);
      }
      if (!repo.isGit) {
        cur.sessions.push(...repo.sessions);
        cur.sessions.sort((a, b) => Number(snap.live.has(b.id)) - Number(snap.live.has(a.id)) || b.lastActivity - a.lastActivity);
      } else if (segs.length === 0) {
        // The root itself is a repo: attach it to the root entry as a repo row.
        entry.repos.push(repo);
      } else {
        cur.repos.push(repo);
      }
      for (const f of chain) {
        f.liveCount += repo.liveCount;
        f.sessionCount += repo.sessions.length;
      }
    }
    this.index = index;
  }
}

function labelOf(n: Node): string {
  return n.kind === 'folder' ? n.label : n.kind === 'repo' ? n.repo.label : '';
}
