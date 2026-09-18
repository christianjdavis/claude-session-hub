import * as vscode from 'vscode';
import type { Hub } from '../hub';
import { displayName } from '../model/types';
import { truncate } from '../format';

/** `$(bell) n  $(check) n  $(sync~spin) n` on the left; click opens the switcher. */
export class HubStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly sub: vscode.Disposable;

  constructor(private readonly hub: Hub) {
    this.item = vscode.window.createStatusBarItem('sessionHub.status', vscode.StatusBarAlignment.Left, 95);
    this.item.name = 'Claude sessions';
    this.item.command = 'sessionHub.switch';
    this.item.show();
    this.render();
    this.sub = hub.onDidChange(() => this.render());
  }

  dispose(): void {
    this.sub.dispose();
    this.item.dispose();
  }

  private render(): void {
    const { counts, queue } = this.hub.snapshot;
    const parts: string[] = [];
    if (counts.needsInput) parts.push(`$(bell-dot) ${counts.needsInput}`);
    if (counts.review) parts.push(`$(check) ${counts.review}`);
    if (counts.running) parts.push(`$(sync~spin) ${counts.running}`);
    if (counts.idle) parts.push(`$(circle-filled) ${counts.idle}`);
    this.item.text = parts.length ? `$(sparkle) ${parts.join('  ')}` : '$(sparkle) no sessions';
    this.item.backgroundColor = counts.needsInput > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    md.appendMarkdown('**Claude Code sessions**\n\n');
    if (queue.length === 0) md.appendMarkdown('Nothing in the queue.\n');
    for (const q of queue.slice(0, 12)) {
      const name = q.job && !q.session ? q.job.name ?? q.job.short : displayName(q.session, q.live);
      const icon = q.kind === 'needsInput' ? '$(bell-dot)' : q.kind === 'review' ? '$(check)' : '$(sync~spin)';
      md.appendMarkdown(`${icon} ${truncate(name, 50)} — ${q.reason}  \n`);
    }
    md.appendMarkdown('\n_Click to switch session_');
    this.item.tooltip = md;
  }
}
