import * as vscode from 'vscode';
import type { Hub } from '../hub';
import type { QueueItem, Session } from '../model/types';
import { displayName, primaryLive } from '../model/types';
import { formatRelativeTime, truncate } from '../format';
import { relToRoots } from '../paths';

type Pick = vscode.QuickPickItem & { sessionId?: string; jobShort?: string };

/** Dropdown of sessions grouped by queue state; accept → focus. */
export async function showSwitcher(hub: Hub): Promise<void> {
  const snap = hub.snapshot;
  const roots = hub.config.roots;
  const items: Pick[] = [];
  const seen = new Set<string>();

  const push = (sep: string, list: QueueItem[]) => {
    if (list.length === 0) return;
    items.push({ label: sep, kind: vscode.QuickPickItemKind.Separator });
    for (const q of list) {
      seen.add(q.sessionId);
      const name = q.job && !q.session ? q.job.name ?? q.job.short : displayName(q.session, q.live);
      const cwd = q.session?.cwd ?? q.live?.cwd ?? q.job?.cwd ?? '';
      items.push({
        label: `${iconFor(q)} ${truncate(name, 60)}`,
        description: relToRoots(roots, cwd),
        detail: `${q.reason} · ${formatRelativeTime(q.since)}${q.session?.gitBranch ? ` · ${q.session.gitBranch}` : ''}`,
        ...(q.job && !q.live ? { jobShort: q.job.short } : { sessionId: q.sessionId })
      });
    }
  };
  push('Needs input', snap.queue.filter(q => q.kind === 'needsInput'));
  push('Completed · review', snap.queue.filter(q => q.kind === 'review'));
  push('Running', snap.queue.filter(q => q.kind === 'running'));

  const idle: Array<[string, Session | null, number]> = [];
  for (const [id, list] of snap.live) {
    const l = primaryLive(list);
    if (!l || l.kind !== 'interactive' || seen.has(id)) continue;
    idle.push([id, snap.sessions.get(id) ?? null, l.statusUpdatedAt]);
  }
  idle.sort((a, b) => b[2] - a[2]);
  if (idle.length) {
    items.push({ label: 'Idle', kind: vscode.QuickPickItemKind.Separator });
    for (const [id, s, ts] of idle) {
      seen.add(id);
      items.push({
        label: `$(circle-filled) ${truncate(displayName(s, primaryLive(snap.live.get(id))), 60)}`,
        description: relToRoots(roots, s?.cwd ?? ''),
        detail: `idle · ${formatRelativeTime(ts)}${s?.gitBranch ? ` · ${s.gitBranch}` : ''}`,
        sessionId: id
      });
    }
  }

  const recent = [...snap.sessions.values()]
    .filter(s => s.inWorkspace && !seen.has(s.id) && s.filePath)
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .slice(0, 15);
  if (recent.length) {
    items.push({ label: 'Recent (not running)', kind: vscode.QuickPickItemKind.Separator });
    for (const s of recent) {
      items.push({
        label: `$(history) ${truncate(displayName(s, null), 60)}`,
        description: relToRoots(roots, s.cwd),
        detail: `${formatRelativeTime(s.lastActivity)}${s.gitBranch ? ` · ${s.gitBranch}` : ''}`,
        sessionId: s.id
      });
    }
  }

  if (items.length === 0) {
    void vscode.window.showInformationMessage('No Claude Code sessions found.');
    return;
  }
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Switch to a Claude Code session',
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!pick) return;
  if (pick.jobShort) {
    const job = snap.jobs.find(j => j.short === pick.jobShort);
    if (job) hub.terminals.attachJob(job);
    return;
  }
  if (pick.sessionId) await hub.terminals.focus(pick.sessionId);
}

function iconFor(q: QueueItem): string {
  switch (q.kind) {
    case 'needsInput':
      return '$(bell-dot)';
    case 'review':
      return '$(check)';
    case 'running':
      return '$(sync~spin)';
  }
}

/** Cycle to the next/previous live session relative to the active terminal. */
export async function cycle(hub: Hub, dir: 1 | -1): Promise<void> {
  const order = hub.terminals.orderedLive();
  if (order.length === 0) {
    void vscode.window.showInformationMessage('No live Claude Code sessions.');
    return;
  }
  const current = hub.terminals.activeSessionId();
  const idx = current ? order.indexOf(current) : -1;
  const next = idx === -1 ? (dir === 1 ? 0 : order.length - 1) : (idx + dir + order.length) % order.length;
  await hub.terminals.focus(order[next] as string);
}

export async function focusNextNeedsInput(hub: Hub): Promise<void> {
  const q = hub.snapshot.queue.find(i => i.kind === 'needsInput') ?? hub.snapshot.queue.find(i => i.kind === 'review');
  if (!q) {
    void vscode.window.showInformationMessage('Nothing is waiting on you.');
    return;
  }
  if (q.job && !q.live) hub.terminals.attachJob(q.job);
  else await hub.terminals.focus(q.sessionId);
}
