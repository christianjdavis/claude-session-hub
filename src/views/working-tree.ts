import * as vscode from 'vscode';
import type { Hub } from '../hub';
import type { Node, SectionId } from './nodes';
import { branchGroupItem, commitItem, commitsGroupItem, browseGroupItem, filesGroupItem, fileFolderItem, fileItem, fsDirItem, fsFileItem, jobItem, liveItem, messageItem, queueItem, sectionItem, sessionItem } from './nodes';
import { primaryLive } from '../model/types';

/** "Working" view: the queue plus everything else that is alive right now. */
export class WorkingTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly hub: Hub) {
    hub.onDidChange(() => this.emitter.fire(undefined));
    hub.onDidChangeNode(node => this.emitter.fire(node));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const ctx = this.hub.itemContext();
    switch (node.kind) {
      case 'section':
        return sectionItem(node, node.id === 'idle' || node.id === 'bg' || node.id === 'outside');
      case 'queue':
        return queueItem(node, ctx);
      case 'live':
        return liveItem(node, ctx);
      case 'job':
        return jobItem(node, ctx);
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
      case 'message':
        return messageItem(node.text);
      default:
        return messageItem('');
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const snap = this.hub.snapshot;
    if (!node) {
      const idle = this.idleNodes();
      const bg = snap.jobs.filter(j => !j.live?.uiPid && (j.live || j.state !== 'done'));
      const outside = this.outsideNodes();
      const sections: Array<Extract<Node, { kind: 'section' }>> = [
        { kind: 'section', id: 'needsInput', label: 'Needs input', count: snap.counts.needsInput },
        { kind: 'section', id: 'review', label: 'Completed · review', count: snap.counts.review },
        { kind: 'section', id: 'running', label: 'Running', count: snap.counts.running },
        { kind: 'section', id: 'idle', label: 'Idle', count: idle.length },
        { kind: 'section', id: 'bg', label: 'Background jobs', count: bg.length },
        { kind: 'section', id: 'outside', label: 'Outside workspace', count: outside.length }
      ];
      if (snap.live.size === 0 && snap.queue.length === 0) {
        return [{ kind: 'message', text: 'No Claude Code sessions are running.' }, ...sections.filter(s => s.count > 0)];
      }
      return sections;
    }
    if (node.kind === 'fileFolder') return node.children;
    if (node.kind === 'queue' || node.kind === 'live' || node.kind === 'session' || node.kind === 'commitsGroup' || node.kind === 'commit' || node.kind === 'branchGroup' || node.kind === 'filesGroup' || node.kind === 'browseGroup' || node.kind === 'fsDir') {
      return this.hub.children(node);
    }
    if (node.kind !== 'section') return [];
    return this.sectionChildren(node.id);
  }

  private sectionChildren(id: SectionId): Node[] {
    const snap = this.hub.snapshot;
    switch (id) {
      case 'needsInput':
      case 'review':
      case 'running':
        return snap.queue.filter(q => q.kind === id).map(item => ({ kind: 'queue', item }) as Node);
      case 'idle':
        return this.idleNodes();
      case 'bg':
        return snap.jobs.filter(j => !j.live?.uiPid && (j.live || j.state !== 'done')).map(job => ({ kind: 'job', job }) as Node);
      case 'outside':
        return this.outsideNodes();
      default:
        return [];
    }
  }

  /** Live interactive sessions that are idle and not in the queue. */
  private idleNodes(): Node[] {
    const snap = this.hub.snapshot;
    const queued = new Set(snap.queue.map(q => q.sessionId));
    const out: Node[] = [];
    for (const [sessionId, list] of snap.live) {
      const live = primaryLive(list);
      if (!live || live.kind !== 'interactive' || queued.has(sessionId)) continue;
      const session = snap.sessions.get(sessionId) ?? null;
      if (session && !session.inWorkspace) continue;
      out.push({ kind: 'live', sessionId, live, session });
    }
    out.sort((a, b) => (b as Extract<Node, { kind: 'live' }>).live.statusUpdatedAt - (a as Extract<Node, { kind: 'live' }>).live.statusUpdatedAt);
    return out;
  }

  private outsideNodes(): Node[] {
    const snap = this.hub.snapshot;
    const out: Node[] = [];
    for (const [sessionId, list] of snap.live) {
      const live = primaryLive(list);
      const session = snap.sessions.get(sessionId) ?? null;
      if (!live || !session || session.inWorkspace) continue;
      out.push({ kind: 'session', session, live });
    }
    return out;
  }
}
