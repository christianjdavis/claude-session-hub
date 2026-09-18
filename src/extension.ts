import * as vscode from 'vscode';
import { Hub } from './hub';
import { displayName, primaryLive } from './model/types';
import type { BgJob } from './model/types';
import { cwdIsWorkspaceFolder, officialExtensionPresent, openInOfficialExtension } from './integrations/official-ext';
import { checkClaudeCli } from './integrations/prereqs';
import { HubStatusBar } from './ui/status-bar';
import { cycle, focusNextNeedsInput, showSwitcher } from './ui/switcher';
import { ReposTreeProvider } from './views/repos-tree';
import { WorkingTreeProvider } from './views/working-tree';
import type { Node } from './views/nodes';
import { dirOf, jobOf, sessionIdOf, sessionOf } from './views/nodes';
import { FsDropController } from './views/drop';
import { uploadInto } from './fs/upload';
import { shortenHomePath } from './paths';
import { formatRelativeTime } from './format';

/** Serves `sessionhub-git:` documents: a file's content at a git ref, for diffs against the working tree. */
const GIT_SCHEME = 'sessionhub-git';
function gitUri(repoRoot: string, absPath: string, ref: string): vscode.Uri {
  return vscode.Uri.from({ scheme: GIT_SCHEME, path: absPath, query: new URLSearchParams({ root: repoRoot, ref }).toString() });
}
const SUMMARY_SCHEME = 'sessionhub-summary';

export function activate(context: vscode.ExtensionContext): void {
  const hub = new Hub(context);
  context.subscriptions.push(hub);

  const working = new WorkingTreeProvider(hub);
  const repos = new ReposTreeProvider(hub);
  const dragAndDropController = new FsDropController(hub);
  const workingView = vscode.window.createTreeView('sessionHub.working', { treeDataProvider: working, showCollapseAll: false, dragAndDropController });
  const reposView = vscode.window.createTreeView('sessionHub.repos', { treeDataProvider: repos, showCollapseAll: true, dragAndDropController });
  context.subscriptions.push(workingView, reposView, new HubStatusBar(hub));

  context.subscriptions.push(
    hub.onDidChange(snap => {
      const n = snap.counts.needsInput + snap.counts.review;
      workingView.badge = n > 0 ? { value: n, tooltip: `${snap.counts.needsInput} need input · ${snap.counts.review} to review` } : undefined;
    })
  );
  void vscode.commands.executeCommand('setContext', 'sessionHub.officialExtension', officialExtensionPresent());

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, {
      provideTextDocumentContent: async uri => {
        const q = new URLSearchParams(uri.query);
        const root = q.get('root');
        const ref = q.get('ref') ?? 'HEAD';
        if (!root) return '';
        return hub.gitShow(root, ref, uri.path);
      }
    }),
    vscode.workspace.registerTextDocumentContentProvider(SUMMARY_SCHEME, {
      provideTextDocumentContent: async uri => {
        const id = uri.path.replace(/^\//, '').replace(/\.md$/, '');
        const s = hub.snapshot.sessions.get(id);
        if (!s) return `# Session ${id}\n\nNot found in the current snapshot.`;
        const live = primaryLive(hub.snapshot.live.get(id));
        const g = await hub.sessionGroups(s).catch(() => null);
        const files = g?.files ?? [];
        const commits = g?.commits ?? [];
        const lines = [
          `# ${displayName(s, live)}`,
          '',
          `- Directory: \`${shortenHomePath(s.cwd)}\`${s.gitBranch ? `  (branch \`${s.gitBranch}\`)` : ''}`,
          `- Status: ${live ? `${live.status}${live.waitingFor ? ` — ${live.waitingFor}` : ''}` : 'not running'}`,
          s.lastUserTs ? `- Last prompt: ${formatRelativeTime(s.lastUserTs)}` : '',
          s.lastEndTurnTs ? `- Last finished: ${formatRelativeTime(s.lastEndTurnTs)}` : '',
          s.prLink ? `- PR: ${s.prLink.url}` : '',
          `- Session id: \`${s.id}\``,
          '',
          '## Commits during this session',
          '',
          ...(commits.length ? commits.map(c => `- \`${c.short}\` ${c.subject} _(${formatRelativeTime(c.ts)})_`) : ['_none_']),
          '',
          `## Files changed${g?.from && g.from !== 'HEAD' ? ` (since ${g.from.slice(0, 10)})` : ''}`,
          '',
          ...(files.length
            ? files.map(f => {
                const rel = f.repoRoot && f.path.startsWith(f.repoRoot) ? f.path.slice(f.repoRoot.length + 1) : shortenHomePath(f.path);
                const where = f.inCommits && f.inWorkingTree ? 'committed, edited since' : f.inCommits ? 'committed' : f.inWorkingTree ? 'uncommitted' : '';
                return `- \`${rel}\` — ${f.status}${where ? ` · ${where}` : ''}${f.thisTurn ? ' · this turn' : ''}`;
              })
            : ['_none recorded_']),
          '',
          '## Last message from Claude',
          '',
          s.lastAssistantText ?? '_none_'
        ];
        return lines.filter(l => l !== null).join('\n');
      }
    })
  );

  const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, (...args: unknown[]) => Promise.resolve(fn(...args)).catch(err => hub.log(`${id} failed: ${(err as Error).stack ?? err}`))));

  const idFrom = (arg: unknown): string | null => (typeof arg === 'string' ? arg : sessionIdOf(arg as Node | undefined));

  reg('sessionHub.refresh', () => hub.refresh(true));
  reg('sessionHub.showLogs', () => hub.output.show());
  reg('sessionHub.switch', () => showSwitcher(hub));
  reg('sessionHub.next', () => cycle(hub, 1));
  reg('sessionHub.prev', () => cycle(hub, -1));
  reg('sessionHub.focusNextNeedsInput', () => focusNextNeedsInput(hub));

  reg('sessionHub.focus', async arg => {
    const id = idFrom(arg);
    if (!id) return;
    const session = hub.snapshot.sessions.get(id);
    if (hub.config.useOfficialExtensionWhenCwdMatches && session && officialExtensionPresent() && cwdIsWorkspaceFolder(session)) {
      if (await openInOfficialExtension(session)) {
        await hub.onSessionFocused(id);
        return;
      }
    }
    await hub.terminals.focus(id);
  });
  reg('sessionHub.openSession', arg => vscode.commands.executeCommand('sessionHub.focus', arg));
  reg('sessionHub.resumeHistorical', arg => {
    const id = idFrom(arg);
    if (id) return hub.terminals.focus(id);
  });
  reg('sessionHub.openInOfficialExtension', async arg => {
    const s = sessionOf(arg as Node | undefined) ?? (idFrom(arg) ? hub.snapshot.sessions.get(idFrom(arg) as string) : undefined);
    if (s) await openInOfficialExtension(s);
  });

  reg('sessionHub.markReviewed', async arg => {
    const node = arg as Node | undefined;
    if (node?.kind === 'queue' && node.item.reviewKey) return hub.markReviewed(node.item.reviewKey);
    const id = idFrom(arg) ?? hub.terminals.activeSessionId();
    const item = hub.snapshot.queue.find(q => q.kind === 'review' && q.sessionId === id);
    if (item?.reviewKey) await hub.markReviewed(item.reviewKey);
  });
  reg('sessionHub.markAllReviewed', () => hub.markReviewed(...hub.snapshot.queue.filter(q => q.kind === 'review' && q.reviewKey).map(q => q.reviewKey as string)));

  const cwdFrom = (arg: unknown): string | null => {
    const node = arg as Node | undefined;
    const dir = dirOf(node);
    if (dir) return dir;
    const s = sessionOf(node);
    return s ? s.cwdReal : null;
  };
  /** Every way of starting a session asks for a name first; leave it blank for an unnamed one, Escape cancels. */
  const startSession = async (cwd: string | null) => {
    if (!cwd) return;
    const name = await vscode.window.showInputBox({
      title: `New Claude session in ${shortenHomePath(cwd)}`,
      prompt: 'Session name (shown in the prompt box and this view). Leave empty for no name.',
      placeHolder: 'fix-login-redirect'
    });
    if (name === undefined) return;
    hub.terminals.startNew(cwd, name.trim() || undefined);
  };
  reg('sessionHub.newSession', async arg => startSession(cwdFrom(arg) ?? (await pickRepo(hub))));
  reg('sessionHub.newSessionPick', async () => startSession(await pickRepo(hub)));
  reg('sessionHub.forkSession', arg => {
    const id = idFrom(arg);
    const s = id ? hub.snapshot.sessions.get(id) : undefined;
    if (!id || !s) return;
    const cfg = hub.config;
    hub.terminals.runInNewTerminal(s.cwdReal, `${cfg.claudePath} --resume ${id} --fork-session ${cfg.extraResumeArgs}`.trim(), `fork · ${displayName(s, null)}`);
  });

  const jobFrom = (arg: unknown): BgJob | null => jobOf(arg as Node | undefined);
  reg('sessionHub.attachBg', arg => {
    const j = jobFrom(arg);
    if (j) hub.terminals.attachJob(j);
  });
  reg('sessionHub.bgLogs', arg => {
    const j = jobFrom(arg);
    if (j) hub.terminals.runInNewTerminal(j.cwd ?? process.env['HOME'] ?? '/', `${hub.config.claudePath} logs ${j.short}`, `logs · ${j.name ?? j.short}`);
  });
  reg('sessionHub.bgStop', async arg => {
    const j = jobFrom(arg);
    if (!j) return;
    const ok = await vscode.window.showWarningMessage(`Stop background session "${j.name ?? j.short}"? Its conversation is kept and can be attached later.`, { modal: true }, 'Stop');
    if (ok === 'Stop') hub.terminals.runInNewTerminal(j.cwd ?? process.env['HOME'] ?? '/', `${hub.config.claudePath} stop ${j.short}`, `stop · ${j.name ?? j.short}`);
  });

  reg('sessionHub.copySessionId', async arg => {
    const id = idFrom(arg) ?? hub.terminals.activeSessionId();
    if (!id) return;
    await vscode.env.clipboard.writeText(id);
    void vscode.window.setStatusBarMessage(`Copied session id ${id.slice(0, 8)}…`, 2500);
  });
  reg('sessionHub.openTranscript', async arg => {
    const id = idFrom(arg);
    const s = id ? hub.snapshot.sessions.get(id) : undefined;
    if (!s?.filePath) {
      void vscode.window.showInformationMessage('No transcript on disk for this session yet.');
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(s.filePath), { preview: true });
  });
  reg('sessionHub.openRepoWindow', async arg => {
    const node = arg as Node | undefined;
    const s = sessionOf(node);
    const root = node?.kind === 'repo' ? node.repo.root : s ? s.repoRoot ?? s.cwdReal : cwdFrom(arg);
    if (!root) return;
    const uri = vscode.Uri.file(root);
    if (vscode.workspace.workspaceFolders?.some(f => f.uri.fsPath === uri.fsPath)) {
      void vscode.window.setStatusBarMessage(`${shortenHomePath(root)} is this window's folder`, 2500);
      return;
    }
    // VS Code focuses an existing window that already has this folder open instead of opening a second one.
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
  });
  reg('sessionHub.revealCwd', async arg => {
    const cwd = cwdFrom(arg);
    if (cwd) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(cwd));
  });
  reg('sessionHub.openDiff', async arg => {
    const node = arg as Node | undefined;
    if (node?.kind !== 'file') return;
    const f = node.file;
    const fileUri = vscode.Uri.file(f.path);
    const name = f.path.split('/').pop() ?? f.path;
    if (f.refs && f.repoRoot) {
      // Commit or branch diff: compare two git refs (or a ref against the working tree).
      const left = f.refs.from ? gitUri(f.repoRoot, f.path, f.refs.from) : null;
      const right = f.refs.to ? gitUri(f.repoRoot, f.path, f.refs.to) : fileUri;
      const label = `${name} (${f.refs.from?.slice(0, 10) ?? '∅'} ↔ ${f.refs.to?.slice(0, 10) ?? 'working tree'})`;
      if (f.status === 'A' || !left) {
        await vscode.window.showTextDocument(right, { preview: true });
        return;
      }
      if (f.status === 'D') {
        await vscode.window.showTextDocument(left, { preview: true });
        return;
      }
      await vscode.commands.executeCommand('vscode.diff', left, right, label, { preview: true });
      return;
    }
    if (f.status === 'missing') {
      void vscode.window.showInformationMessage(`${name} no longer exists on disk.`);
      return;
    }
    if (!f.repoRoot || f.status === '?' || f.status === 'clean') {
      await vscode.window.showTextDocument(fileUri, { preview: true });
      return;
    }
    const head = gitUri(f.repoRoot, f.path, 'HEAD');
    if (f.status === 'D') {
      await vscode.window.showTextDocument(head, { preview: true });
      return;
    }
    await vscode.commands.executeCommand('vscode.diff', head, fileUri, `${name} (HEAD ↔ working tree)`, { preview: true });
  });
  reg('sessionHub.openFile', async arg => {
    const node = arg as Node | undefined;
    if (node?.kind === 'file' && node.file.status !== 'missing') await vscode.window.showTextDocument(vscode.Uri.file(node.file.path), { preview: true });
  });
  reg('sessionHub.openAllDiffs', async arg => {
    const s = sessionOf(arg as Node | undefined) ?? (idFrom(arg) ? hub.snapshot.sessions.get(idFrom(arg) as string) : undefined);
    if (!s) return;
    const all = (await hub.sessionGroups(s)).files.filter(f => f.status !== 'clean' && f.status !== 'missing');
    const files = all.some(f => f.thisTurn) ? all.filter(f => f.thisTurn) : all;
    if (files.length === 0) {
      void vscode.window.showInformationMessage('No file changes recorded for this session.');
      return;
    }
    for (const f of files.slice(0, 12)) await vscode.commands.executeCommand('sessionHub.openDiff', { kind: 'file', file: f, sessionId: s.id } satisfies Node);
  });
  reg('sessionHub.showSummary', async arg => {
    const id = idFrom(arg) ?? hub.terminals.activeSessionId();
    if (!id) return;
    const uri = vscode.Uri.from({ scheme: SUMMARY_SCHEME, path: `/${id}.md` });
    await vscode.commands.executeCommand('markdown.showPreview', uri);
  });
  // File browser: upload (copy in) files, open/copy paths, and the hidden-entries toggle.
  reg('sessionHub.uploadFiles', async arg => {
    const dir = dirOf(arg as Node | undefined) ?? (await pickRepo(hub));
    if (!dir) return;
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: true,
      openLabel: 'Upload',
      title: `Upload into ${shortenHomePath(dir)}`
    });
    if (!picked?.length) return;
    const n = await uploadInto(dir, picked);
    if (n > 0) hub.invalidateDir(dir);
  });
  reg('sessionHub.openFileToSide', async arg => {
    const node = arg as Node | undefined;
    if (node?.kind === 'fsFile') await vscode.window.showTextDocument(vscode.Uri.file(node.path), { viewColumn: vscode.ViewColumn.Beside, preview: false });
    else if (node?.kind === 'file' && node.file.status !== 'missing') await vscode.window.showTextDocument(vscode.Uri.file(node.file.path), { viewColumn: vscode.ViewColumn.Beside, preview: false });
  });
  reg('sessionHub.copyPath', async arg => {
    const node = arg as Node | undefined;
    const p = node?.kind === 'fsFile' ? node.path : node?.kind === 'file' ? node.file.path : dirOf(node);
    if (!p) return;
    await vscode.env.clipboard.writeText(p);
    void vscode.window.setStatusBarMessage(`Copied ${shortenHomePath(p)}`, 2000);
  });
  reg('sessionHub.showHiddenFiles', () => hub.setShowHidden(true));
  reg('sessionHub.hideHiddenFiles', () => hub.setShowHidden(false));
  reg('sessionHub.toggleTerminalLocation', async () => {
    const cur = hub.config.terminalLocation;
    const next = cur === 'editor' ? 'panel' : 'editor';
    await vscode.workspace.getConfiguration('sessionHub').update('terminalLocation', next, vscode.ConfigurationTarget.Global);
    void vscode.window.setStatusBarMessage(`New session terminals open in the ${next}`, 2500);
  });

  hub.log(`activated · roots: ${hub.config.roots.join(', ')} · scanning: ${hub.backendKind}`);
  void hub.refresh();
  void checkClaudeCli(hub, context);
}

export function deactivate(): void {
  /* disposables handle cleanup */
}

async function pickRepo(hub: Hub): Promise<string | null> {
  const roots = hub.itemContext().roots;
  const items = hub.snapshot.repos.map(r => ({
    label: r.relPath,
    description: r.liveCount ? `${r.liveCount} live` : r.sessions[0] ? `last ${displayName(r.sessions[0], primaryLive(hub.snapshot.live.get(r.sessions[0].id)))}` : '',
    root: r.root
  }));
  const browse = { label: '$(folder-opened) Browse for a folder…', description: 'any directory, not just known repos', root: '' };
  const pick = await vscode.window.showQuickPick([browse, ...items], { placeHolder: 'Start a new Claude Code session in…', matchOnDescription: true });
  if (!pick) return null;
  if (pick === browse) {
    const opts: vscode.OpenDialogOptions = { canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Start session here' };
    if (roots[0]) opts.defaultUri = vscode.Uri.file(roots[0]);
    const chosen = await vscode.window.showOpenDialog(opts);
    return chosen?.[0]?.fsPath ?? null;
  }
  return pick.root;
}
