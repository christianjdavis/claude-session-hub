import * as vscode from 'vscode';
import type { BgJob, LiveSession, QueueItem, Repo, Session, Snapshot } from '../model/types';
import type { ChangedFile, Commit } from '../sources/changes';
import { displayName, primaryLive } from '../model/types';
import { escapeMarkdown, formatRelativeTime, truncate } from '../format';
import { relToRoots, shortenHomePath } from '../paths';

export type SectionId = 'needsInput' | 'review' | 'running' | 'idle' | 'bg' | 'outside' | 'other';
export type ScmGroupId = 'staged' | 'changes' | 'committed' | 'other';

export type Node =
  | { kind: 'section'; id: SectionId; label: string; count: number }
  | { kind: 'queue'; item: QueueItem }
  | { kind: 'live'; sessionId: string; live: LiveSession; session: Session | null }
  | { kind: 'repo'; repo: Repo }
  | { kind: 'folder'; path: string; relPath: string; label: string; liveCount: number; sessionCount: number }
  | { kind: 'session'; session: Session; live: LiveSession | null }
  | { kind: 'job'; job: BgJob }
  | { kind: 'file'; file: ChangedFile; sessionId: string; inFolder?: boolean }
  | { kind: 'fileFolder'; sessionId: string; label: string; rel: string; count: number; children: Node[]; expanded: boolean; scope?: string }
  /** Source-control style buckets under "Files changed": staged, unstaged, committed-only, outside git. */
  | { kind: 'scmGroup'; sessionId: string; group: ScmGroupId; files: ChangedFile[]; children: Node[] }
  | { kind: 'commitsGroup'; sessionId: string; commits: Commit[] }
  | { kind: 'commit'; sessionId: string; commit: Commit }
  | { kind: 'branchGroup'; sessionId: string; repoRoot: string; base: string; count: number | null }
  | { kind: 'filesGroup'; sessionId: string; count: number; commitCount: number; from: string | null }
  /** File browser: the whole tree under a session's repo/cwd or a repo/folder row, not just what changed. */
  | { kind: 'browseGroup'; sessionId: string | null; root: string; repoRoot: string | null }
  | { kind: 'fsDir'; sessionId: string | null; root: string; repoRoot: string | null; path: string; ignored: boolean }
  | { kind: 'fsFile'; sessionId: string | null; root: string; path: string; ignored: boolean }
  | { kind: 'message'; text: string };

/** Directory a file-system action (upload, new session, reveal) should target, for any node that has one. */
export function dirOf(node: Node | undefined): string | null {
  if (!node) return null;
  switch (node.kind) {
    case 'repo':
      return node.repo.root;
    case 'folder':
      return node.path;
    case 'browseGroup':
      return node.root;
    case 'fsDir':
      return node.path;
    case 'fsFile':
      return node.path.slice(0, node.path.lastIndexOf('/')) || '/';
    default:
      return null;
  }
}

/** Session id a command should act on, for any node that has one. */
export function sessionIdOf(node: Node | undefined): string | null {
  if (!node) return null;
  switch (node.kind) {
    case 'queue':
      return node.item.job && !node.item.session ? null : node.item.sessionId;
    case 'live':
      return node.sessionId;
    case 'session':
      return node.session.id;
    case 'job':
      return node.job.sessionId;
    default:
      return null;
  }
}

export function jobOf(node: Node | undefined): BgJob | null {
  if (!node) return null;
  if (node.kind === 'job') return node.job;
  if (node.kind === 'queue') return node.item.job;
  return null;
}

export function sessionOf(node: Node | undefined): Session | null {
  if (!node) return null;
  if (node.kind === 'session') return node.session;
  if (node.kind === 'queue') return node.item.session;
  if (node.kind === 'live') return node.session;
  return null;
}

export interface ItemContext {
  roots: string[];
  extensionUri: vscode.Uri;
  snapshot: Snapshot;
  /** Paths pinned into the Focus view. */
  pinned: ReadonlySet<string>;
}

export function sectionItem(node: Extract<Node, { kind: 'section' }>, collapsed: boolean): vscode.TreeItem {
  const item = new vscode.TreeItem(
    node.label,
    node.count === 0 ? vscode.TreeItemCollapsibleState.None : collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded
  );
  item.description = String(node.count);
  item.contextValue = `sh.section.${node.id}`;
  item.id = `section:${node.id}`;
  const icons: Record<SectionId, string> = {
    needsInput: 'bell',
    review: 'eye',
    running: 'play',
    idle: 'circle-outline',
    bg: 'server-process',
    outside: 'globe',
    other: 'history'
  };
  item.iconPath = new vscode.ThemeIcon(icons[node.id]);
  return item;
}

export function queueItem(node: Extract<Node, { kind: 'queue' }>, ctx: ItemContext): vscode.TreeItem {
  const { item: q } = node;
  const name = q.job && !q.session ? q.job.name ?? q.job.short : displayName(q.session, q.live);
  const item = new vscode.TreeItem(truncate(name, 60), expandable(q.session));
  const cwd = q.session?.cwd ?? q.live?.cwd ?? q.job?.cwd ?? '';
  item.description = [relToRoots(ctx.roots, cwd), q.reason, formatRelativeTime(q.since)].filter(Boolean).join(' · ');
  item.id = q.job && !q.session ? `job:${q.job.short}` : `s:${q.sessionId}`;
  item.contextValue = `sh.queue.${q.kind}${q.job ? '.job' : ''}`;
  item.iconPath = queueIcon(q);
  item.tooltip = sessionTooltip(q.session, q.live, q.job, ctx.roots, q.reason);
  item.command = openCommand(q.sessionId, q.job);
  return item;
}

export function liveItem(node: Extract<Node, { kind: 'live' }>, ctx: ItemContext): vscode.TreeItem {
  const name = displayName(node.session, node.live);
  const item = new vscode.TreeItem(truncate(name, 60), expandable(node.session));
  item.description = [relToRoots(ctx.roots, node.live.cwd), node.session?.gitBranch ?? '', formatRelativeTime(node.live.statusUpdatedAt)]
    .filter(Boolean)
    .join(' · ');
  item.id = `s:${node.sessionId}`;
  item.contextValue = 'sh.live';
  item.iconPath = statusIcon(node.live.status);
  item.tooltip = sessionTooltip(node.session, node.live, null, ctx.roots, node.live.status);
  item.command = openCommand(node.sessionId, null);
  return item;
}

export function repoItem(node: Extract<Node, { kind: 'repo' }>, ctx: ItemContext): vscode.TreeItem {
  const r = node.repo;
  const item = new vscode.TreeItem(
    r.label,
    r.liveCount > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
  );
  const parts: string[] = [];
  if (r.liveCount > 0) parts.push(`${r.liveCount} live`);
  if (r.sessions.length > 0) parts.push(`${r.sessions.length} session${r.sessions.length === 1 ? '' : 's'}`);
  item.description = parts.join(' · ');
  item.id = `repo:${r.root}`;
  item.contextValue = ctx.pinned.has(r.root) ? 'sh.repo.pinned' : 'sh.repo';
  item.iconPath = new vscode.ThemeIcon(r.isGit ? 'repo' : 'folder', r.liveCount > 0 ? new vscode.ThemeColor('charts.green') : undefined);
  item.tooltip = shortenHomePath(r.root);
  item.resourceUri = vscode.Uri.file(r.root);
  return item;
}

export function folderItem(node: Extract<Node, { kind: 'folder' }>, ctx: ItemContext): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, node.liveCount > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
  const parts: string[] = [];
  if (node.liveCount > 0) parts.push(`${node.liveCount} live`);
  if (node.sessionCount > 0) parts.push(`${node.sessionCount} session${node.sessionCount === 1 ? '' : 's'}`);
  item.description = parts.join(' · ');
  item.id = `folder:${node.path}`;
  item.contextValue = ctx.pinned.has(node.path) ? 'sh.folder.pinned' : 'sh.folder';
  item.iconPath = new vscode.ThemeIcon('folder', node.liveCount > 0 ? new vscode.ThemeColor('charts.green') : undefined);
  item.tooltip = shortenHomePath(node.path);
  item.resourceUri = vscode.Uri.file(node.path);
  return item;
}

export function sessionItem(node: Extract<Node, { kind: 'session' }>, ctx: ItemContext): vscode.TreeItem {
  const { session: s, live } = node;
  const item = new vscode.TreeItem(truncate(displayName(s, live), 60), expandable(s));
  const parts = [s.gitBranch ?? '', live ? live.status : formatRelativeTime(s.lastActivity)];
  if (!s.inWorkspace) parts.unshift(shortenHomePath(s.cwd));
  item.description = parts.filter(Boolean).join(' · ');
  item.id = `s:${s.id}`;
  item.contextValue = live ? 'sh.session.live' : 'sh.session.historical';
  item.iconPath = live ? statusIcon(live.status) : new vscode.ThemeIcon('history');
  item.tooltip = sessionTooltip(s, live, null, ctx.roots, live?.status ?? 'not running');
  item.command = openCommand(s.id, null);
  return item;
}

export function jobItem(node: Extract<Node, { kind: 'job' }>, ctx: ItemContext): vscode.TreeItem {
  const j = node.job;
  const item = new vscode.TreeItem(truncate(j.name ?? j.short, 60), vscode.TreeItemCollapsibleState.None);
  item.description = [j.cwd ? relToRoots(ctx.roots, j.cwd) : '', j.state, formatRelativeTime(j.updatedAt)].filter(Boolean).join(' · ');
  item.id = `job:${j.short}`;
  item.contextValue = `sh.job.${j.live ? 'live' : 'done'}`;
  item.iconPath = new vscode.ThemeIcon(
    j.live ? 'server-process' : j.state === 'failed' ? 'error' : 'server',
    j.state === 'failed' ? new vscode.ThemeColor('charts.red') : undefined
  );
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${escapeMarkdown(j.name ?? j.short)}**  \n`);
  md.appendMarkdown(`\`claude attach ${j.short}\`  \n`);
  if (j.detail) md.appendMarkdown(`${escapeMarkdown(truncate(j.detail, 300))}  \n`);
  if (j.cwd) md.appendMarkdown(`📁 ${escapeMarkdown(shortenHomePath(j.cwd))}  \n`);
  md.appendMarkdown(`state: ${escapeMarkdown(j.state)} · ${formatRelativeTime(j.updatedAt)}`);
  item.tooltip = md;
  item.command = { command: 'sessionHub.attachBg', title: 'Attach', arguments: [node] };
  return item;
}

function expandable(s: Session | null): vscode.TreeItemCollapsibleState {
  return s && s.filePath ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
}

const STATUS_LABEL: Record<ChangedFile['status'], string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  '?': 'untracked',
  clean: 'no working-tree change',
  missing: 'file missing'
};

export function fileItem(node: Extract<Node, { kind: 'file' }>): vscode.TreeItem {
  const f = node.file;
  const item = new vscode.TreeItem(vscode.Uri.file(f.path), vscode.TreeItemCollapsibleState.None);
  const base = f.repoRoot ?? '';
  const rel = base && f.path.startsWith(base) ? f.path.slice(base.length + 1) : shortenHomePath(f.path);
  item.label = rel.split('/').pop() ?? rel;
  const dir = node.inFolder ? '' : rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const aggregate = f.inCommits !== undefined;
  let where = '';
  if (aggregate) {
    if (f.inCommits && f.inWorkingTree) where = 'committed, edited since';
    else if (f.inCommits) where = 'committed';
    else if (f.inWorkingTree) where = 'uncommitted';
  }
  const turn = f.thisTurn ? (aggregate ? 'this turn' : '') : f.lastEditTs ? 'earlier turn' : aggregate ? '' : 'uncommitted';
  item.description = [dir, f.status === 'clean' ? '' : STATUS_LABEL[f.status], where, turn].filter(Boolean).join(' · ');
  item.id = `file:${node.sessionId}:${f.refs ? `${f.refs.from ?? ''}..${f.refs.to ?? ''}:` : ''}${f.path}`;
  // `+staged` / `+unstaged` drive the Stage / Unstage / Discard buttons (menu `when` clauses match on them).
  item.contextValue = `sh.file.${f.status === '?' || f.status === 'missing' || f.status === 'clean' ? 'plain' : 'diff'}${f.staged ? '+staged' : ''}${f.unstaged ? '+unstaged' : ''}`;
  item.tooltip = `${shortenHomePath(f.path)}\n${STATUS_LABEL[f.status]}${where ? ` · ${where}` : ''}${f.lastEditTs ? ` · edited ${formatRelativeTime(f.lastEditTs)}` : ''}`;
  if (f.status !== 'clean') {
    const color = f.status === 'D' || f.status === 'missing' ? 'gitDecoration.deletedResourceForeground' : f.status === '?' || f.status === 'A' ? 'gitDecoration.untrackedResourceForeground' : 'gitDecoration.modifiedResourceForeground';
    item.iconPath = new vscode.ThemeIcon(f.status === 'D' || f.status === 'missing' ? 'diff-removed' : f.status === '?' || f.status === 'A' ? 'diff-added' : 'diff-modified', new vscode.ThemeColor(color));
  }
  item.command = { command: 'sessionHub.openDiff', title: 'Open diff', arguments: [node] };
  return item;
}

export function fileFolderItem(node: Extract<Node, { kind: 'fileFolder' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
  item.description = `${node.count} file${node.count === 1 ? '' : 's'}`;
  item.id = `dir:${node.sessionId}:${node.scope ?? ''}:${node.rel}`;
  item.contextValue = 'sh.fileFolder';
  item.iconPath = vscode.ThemeIcon.Folder;
  item.tooltip = node.rel;
  return item;
}

const SCM_LABEL: Record<ScmGroupId, string> = { staged: 'Staged Changes', changes: 'Changes', committed: 'Committed', other: 'Other files' };
const SCM_TOOLTIP: Record<ScmGroupId, string> = {
  staged: 'In the index, ready to commit (HEAD ↔ index). Unstage to move a file back to Changes.',
  changes: 'Working-tree edits not yet staged, untracked files included (index ↔ working tree). Stage to move a file up; Discard throws the edit away.',
  committed: 'Changed by a commit made during this session and unchanged since.',
  other: 'Edited by this session outside any git repository.'
};

export function scmGroupItem(node: Extract<Node, { kind: 'scmGroup' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(SCM_LABEL[node.group], vscode.TreeItemCollapsibleState.Expanded);
  item.description = String(node.files.length);
  item.id = `scm:${node.sessionId}:${node.group}`;
  item.contextValue = `sh.scm.${node.group}`;
  item.tooltip = SCM_TOOLTIP[node.group];
  return item;
}

export function commitsGroupItem(node: Extract<Node, { kind: 'commitsGroup' }>): vscode.TreeItem {
  const item = new vscode.TreeItem('Commits', node.commits.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
  item.description = node.commits.length ? `${node.commits.length} during this session` : 'none during this session';
  item.id = `commits:${node.sessionId}`;
  item.contextValue = 'sh.commitsGroup';
  item.iconPath = new vscode.ThemeIcon('git-commit');
  return item;
}

export function commitItem(node: Extract<Node, { kind: 'commit' }>): vscode.TreeItem {
  const c = node.commit;
  const item = new vscode.TreeItem(truncate(c.subject || c.short, 70), vscode.TreeItemCollapsibleState.Collapsed);
  item.description = `${c.short} · ${formatRelativeTime(c.ts)}`;
  item.id = `commit:${node.sessionId}:${c.sha}`;
  item.contextValue = 'sh.commit';
  item.iconPath = new vscode.ThemeIcon('git-commit');
  item.tooltip = `${c.sha}\n${c.author} · ${new Date(c.ts).toLocaleString()}\n\n${c.subject}`;
  return item;
}

export function branchGroupItem(node: Extract<Node, { kind: 'branchGroup' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(`Branch vs ${node.base}`, node.count === 0 ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
  item.description = node.count === null ? '' : node.count ? `${node.count} file${node.count === 1 ? '' : 's'}` : 'no differences';
  item.id = `branch:${node.sessionId}`;
  item.contextValue = 'sh.branchGroup';
  item.iconPath = new vscode.ThemeIcon('git-compare');
  item.tooltip = 'Everything this branch changed relative to its merge-base, including uncommitted work.';
  return item;
}

export function filesGroupItem(node: Extract<Node, { kind: 'filesGroup' }>): vscode.TreeItem {
  const item = new vscode.TreeItem('Files changed', node.count ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
  const n = `${node.count} file${node.count === 1 ? '' : 's'}`;
  const k = node.commitCount ? ` · ${node.commitCount} commit${node.commitCount === 1 ? '' : 's'} + working tree` : '';
  item.description = node.count ? `${n}${k}` : node.commitCount ? 'no net changes' : 'none';
  item.id = `files:${node.sessionId}`;
  item.contextValue = 'sh.filesGroup';
  item.iconPath = new vscode.ThemeIcon('git-pull-request');
  item.tooltip = node.from
    ? `Everything this session changed, like a pull request's "Files changed": all its commits plus uncommitted work, compared against ${node.from === 'HEAD' ? 'HEAD' : node.from.slice(0, 10)}.`
    : 'Files this session edited via Edit/Write tools.';
  return item;
}

export function browseGroupItem(node: Extract<Node, { kind: 'browseGroup' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(node.sessionId ? 'Browse files' : 'Files', vscode.TreeItemCollapsibleState.Collapsed);
  item.description = shortenHomePath(node.root);
  item.id = `browse:${node.root}${node.sessionId ? `:${node.sessionId}` : ''}`;
  item.contextValue = 'sh.browseGroup';
  item.iconPath = new vscode.ThemeIcon('files');
  item.tooltip = `Every file under ${shortenHomePath(node.root)}, not only the ones this session changed. Drop files here or use the upload button to copy them in.`;
  return item;
}

export function fsDirItem(node: Extract<Node, { kind: 'fsDir' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(vscode.Uri.file(node.path), vscode.TreeItemCollapsibleState.Collapsed);
  item.id = `fsdir:${node.path}${node.sessionId ? `:${node.sessionId}` : ''}`;
  item.contextValue = 'sh.fsDir';
  if (node.ignored) item.description = 'ignored';
  item.tooltip = shortenHomePath(node.path);
  return item;
}

export function fsFileItem(node: Extract<Node, { kind: 'fsFile' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(vscode.Uri.file(node.path), vscode.TreeItemCollapsibleState.None);
  item.id = `fsfile:${node.path}${node.sessionId ? `:${node.sessionId}` : ''}`;
  item.contextValue = 'sh.fsFile';
  if (node.ignored) item.description = 'ignored';
  item.tooltip = shortenHomePath(node.path);
  item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(node.path), { preview: true }] };
  return item;
}

export function messageItem(text: string): vscode.TreeItem {
  const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon('info');
  item.contextValue = 'sh.message';
  return item;
}

function openCommand(sessionId: string, job: BgJob | null): vscode.Command {
  if (job && !job.live) return { command: 'sessionHub.attachBg', title: 'Attach', arguments: [{ kind: 'job', job } satisfies Node] };
  return { command: 'sessionHub.focus', title: 'Open session', arguments: [sessionId] };
}

function queueIcon(q: QueueItem): vscode.ThemeIcon {
  switch (q.kind) {
    case 'needsInput':
      return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.red'));
    case 'review':
      return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
    case 'running':
      return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
  }
}

export function statusIcon(status: LiveSession['status']): vscode.ThemeIcon {
  switch (status) {
    case 'waiting':
      return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.red'));
    case 'busy':
      return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
    case 'idle':
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
  }
}

function sessionTooltip(s: Session | null, live: LiveSession | null, job: BgJob | null, roots: string[], status: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportThemeIcons = true;
  const name = job && !s ? job.name ?? job.short : displayName(s, live);
  md.appendMarkdown(`**${escapeMarkdown(name)}**  \n`);
  const cwd = s?.cwd ?? live?.cwd ?? job?.cwd;
  if (cwd) md.appendMarkdown(`$(folder) ${escapeMarkdown(shortenHomePath(cwd))}  \n`);
  if (s?.gitBranch) md.appendMarkdown(`$(git-branch) ${escapeMarkdown(s.gitBranch)}  \n`);
  const statusLine = live ? `${live.status}${live.waitingFor ? ` — ${live.waitingFor}` : ''}` : status;
  md.appendMarkdown(`$(pulse) ${escapeMarkdown(statusLine)}`);
  if (live) md.appendMarkdown(` · since ${formatRelativeTime(live.statusUpdatedAt)} · pid ${live.pid}`);
  md.appendMarkdown('  \n');
  if (s?.lastUserTs) md.appendMarkdown(`$(comment) last prompt ${formatRelativeTime(s.lastUserTs)}  \n`);
  if (s?.lastEndTurnTs) md.appendMarkdown(`$(check) last finished ${formatRelativeTime(s.lastEndTurnTs)}  \n`);
  if (s?.prLink) md.appendMarkdown(`$(git-pull-request) PR #${s.prLink.number}  \n`);
  if (live && live.formerNames.length) {
    const former = live.formerNames.map(f => f.name).join(', ');
    md.appendMarkdown(`$(history) formerly ${escapeMarkdown(truncate(former, 120))}  \n`);
  }
  if (s?.lastAssistantText) {
    md.appendMarkdown('\n---\n\n');
    md.appendMarkdown(escapeMarkdown(truncate(s.lastAssistantText, 320)));
    md.appendMarkdown('\n');
  }
  const id = s?.id ?? live?.sessionId;
  if (id) md.appendMarkdown(`\n\`${id}\``);
  void roots;
  return md;
}

export function liveFor(snapshot: Snapshot, sessionId: string): LiveSession | null {
  return primaryLive(snapshot.live.get(sessionId));
}
