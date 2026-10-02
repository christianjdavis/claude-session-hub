import * as vscode from 'vscode';
import type { Hub } from '../hub';

/**
 * Dims ignored entries in the file browser the way the Explorer does. The built-in git
 * extension only decorates repos it has opened, and the browser can be rooted anywhere.
 */
export class IgnoredDecorationProvider implements vscode.FileDecorationProvider {
  readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined>;

  constructor(private readonly hub: Hub) {
    this.onDidChangeFileDecorations = hub.onDidChangeIgnored;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file' || !this.hub.isIgnored(uri.fsPath)) return undefined;
    return { color: new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'), tooltip: 'Ignored' };
  }
}
