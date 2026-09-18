import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import type { Hub } from '../hub';

/** Official installer (https://code.claude.com/docs/en/setup); runs in a visible terminal so the user sees what it does. */
const INSTALL_CMD = 'curl -fsSL https://claude.ai/install.sh | bash';

/** Resolve a command on PATH via the user's login shell (VS Code's own PATH is often narrower). */
export function resolveOnPath(cmd: string): Promise<string | null> {
  return new Promise(resolve => {
    const shell = process.env['SHELL'] || '/bin/zsh';
    execFile(shell, ['-lic', `command -v ${shellQuote(cmd)}`], { timeout: 8000 }, (err, stdout) => {
      const out = stdout.trim().split('\n').pop()?.trim();
      resolve(!err && out ? out : null);
    });
  });
}

/**
 * Nothing should have to be installed by hand before the extension is useful:
 * if the Claude CLI is missing, say so once and offer to run the official installer.
 */
export async function checkClaudeCli(hub: Hub, context: vscode.ExtensionContext): Promise<void> {
  const cfg = hub.config;
  const found = await resolveOnPath(cfg.claudePath);
  if (found) {
    hub.log(`claude CLI: ${found}`);
    return;
  }
  hub.log(`claude CLI "${cfg.claudePath}" not found on PATH`);
  const dismissedKey = 'sessionHub.cliWarningDismissed';
  if (context.globalState.get<boolean>(dismissedKey)) return;
  const choice = await vscode.window.showWarningMessage(
    `Claude Session Hub can read sessions, but "${cfg.claudePath}" is not on your PATH, so it cannot open or start one. Install Claude Code now?`,
    'Install Claude Code',
    'Set path…',
    "Don't ask again"
  );
  if (choice === 'Install Claude Code') {
    const term = vscode.window.createTerminal({ name: 'Install Claude Code', iconPath: new vscode.ThemeIcon('cloud-download') });
    term.show();
    term.sendText(INSTALL_CMD, true);
    void vscode.window.showInformationMessage('Installer running in the terminal. Reload the window when it finishes.');
  } else if (choice === 'Set path…') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'sessionHub.claudePath');
  } else if (choice === "Don't ask again") {
    await context.globalState.update(dismissedKey, true);
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
