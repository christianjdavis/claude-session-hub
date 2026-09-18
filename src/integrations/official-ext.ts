import * as vscode from 'vscode';
import type { Session } from '../model/types';
import { normalizePath } from '../paths';

const OFFICIAL_ID = 'anthropic.claude-code';

export function officialExtensionPresent(): boolean {
  return vscode.extensions.getExtension(OFFICIAL_ID) !== undefined;
}

/** The official extension runs `claude` in the workspace folder, so only bridge when cwd matches one. */
export function cwdIsWorkspaceFolder(session: Session): boolean {
  const folders = (vscode.workspace.workspaceFolders ?? []).map(f => normalizePath(f.uri.fsPath));
  return folders.includes(session.cwdReal) || folders.includes(session.cwd);
}

export async function openInOfficialExtension(session: Session): Promise<boolean> {
  if (!officialExtensionPresent()) {
    void vscode.window.showWarningMessage('The Claude Code extension (anthropic.claude-code) is not installed.');
    return false;
  }
  if (!cwdIsWorkspaceFolder(session)) {
    void vscode.window.showWarningMessage(
      'The Claude Code extension runs in the workspace folder, which differs from this session\'s working directory. Opening it there would resume with the wrong cwd. Use a terminal instead.'
    );
    return false;
  }
  await vscode.commands.executeCommand('claude-vscode.editor.open', session.id);
  return true;
}
