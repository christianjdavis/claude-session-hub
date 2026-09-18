import * as os from 'node:os';
import * as vscode from 'vscode';
import { expandHome, normalizePath } from './paths';

export type TerminalLocationSetting = 'editor' | 'panel';

export interface HubConfig {
  claudePath: string;
  terminalLocation: TerminalLocationSetting;
  roots: string[];
  maxAgeDays: number;
  maxPerRepo: number;
  pollIntervalMs: number;
  clearReviewOnFocus: boolean;
  notificationsEnabled: boolean;
  adoptExternalTerminals: boolean;
  useOfficialExtensionWhenCwdMatches: boolean;
  extraResumeArgs: string;
  repoScanDepth: number;
  /** Run scanning/git in a separate worker process (isolates us from a busy extension host). */
  useWorker: boolean;
}

export const SECTION = 'sessionHub';

export function getConfig(): HubConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  const roots = resolveRoots(c.get<string[]>('roots', []));
  return {
    claudePath: c.get<string>('claudePath', 'claude').trim() || 'claude',
    terminalLocation: c.get<TerminalLocationSetting>('terminalLocation', 'editor'),
    roots,
    maxAgeDays: c.get<number>('maxAgeDays', 14),
    maxPerRepo: c.get<number>('maxPerRepo', 20),
    pollIntervalMs: Math.max(1000, c.get<number>('pollIntervalMs', 5000)),
    clearReviewOnFocus: c.get<boolean>('clearReviewOnFocus', true),
    notificationsEnabled: c.get<boolean>('notifications.enabled', false),
    adoptExternalTerminals: c.get<boolean>('adoptExternalTerminals', true),
    useOfficialExtensionWhenCwdMatches: c.get<boolean>('useOfficialExtensionWhenCwdMatches', false),
    extraResumeArgs: c.get<string>('extraResumeArgs', '').trim(),
    repoScanDepth: Math.min(8, Math.max(1, c.get<number>('repoScanDepth', 4))),
    useWorker: c.get<boolean>('useWorker', true)
  };
}

/** Configured roots, else workspace folders, else ~/dev if it exists, else home. */
function resolveRoots(configured: string[]): string[] {
  const fromSetting = configured.map(r => normalizePath(expandHome(r))).filter(Boolean);
  if (fromSetting.length > 0) return dedupe(fromSetting);
  const ws = (vscode.workspace.workspaceFolders ?? [])
    .filter(f => f.uri.scheme === 'file')
    .map(f => normalizePath(f.uri.fsPath));
  if (ws.length > 0) return dedupe(ws);
  return [normalizePath(os.homedir())];
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}
