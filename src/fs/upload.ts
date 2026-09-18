import * as path from 'node:path';
import * as vscode from 'vscode';
import { shortenHomePath } from '../paths';
import { uploadTargets } from './upload-targets';
export { uploadTargets } from './upload-targets';

/** A dropped item that only carries bytes (dragged in from outside VS Code without a path). */
export interface DroppedData {
  name: string;
  data: () => Thenable<Uint8Array>;
}

type Conflict = 'replace' | 'skip' | 'cancel';

/**
 * Copy files or folders into `dir`, asking before anything is overwritten. Returns how many
 * items were written; the caller refreshes the folder row.
 */
export async function uploadInto(dir: string, sources: vscode.Uri[], dropped: DroppedData[] = []): Promise<number> {
  const targets = uploadTargets(
    sources.map(u => u.fsPath),
    dir
  );
  const items: Array<{ label: string; dst: vscode.Uri; write: (overwrite: boolean) => Thenable<void> }> = [
    ...targets.map(t => ({
      label: path.basename(t.dst),
      dst: vscode.Uri.file(t.dst),
      write: (overwrite: boolean) => vscode.workspace.fs.copy(vscode.Uri.file(t.src), vscode.Uri.file(t.dst), { overwrite })
    })),
    ...dropped.map(d => ({
      label: d.name,
      dst: vscode.Uri.file(path.join(dir, d.name)),
      write: async () => vscode.workspace.fs.writeFile(vscode.Uri.file(path.join(dir, d.name)), await d.data())
    }))
  ];
  if (items.length === 0) return 0;
  const existing = new Set<string>();
  for (const it of items) if (await exists(it.dst)) existing.add(it.dst.fsPath);

  let replaceAll = false;
  let written = 0;
  for (const it of items) {
    let overwrite = false;
    if (existing.has(it.dst.fsPath)) {
      if (!replaceAll) {
        const choice = await askConflict(it.label, dir, existing.size > 1);
        if (choice === 'cancel') break;
        if (choice === 'skip') continue;
        if (choice === 'replaceAll') replaceAll = true;
      }
      overwrite = true;
    }
    try {
      await it.write(overwrite);
      written++;
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not copy ${it.label}: ${(err as Error).message}`);
    }
  }
  if (written > 0) void vscode.window.setStatusBarMessage(`Uploaded ${written} item${written === 1 ? '' : 's'} to ${shortenHomePath(dir)}`, 4000);
  return written;
}

async function askConflict(name: string, dir: string, several: boolean): Promise<Conflict | 'replaceAll'> {
  const options = several ? ['Replace', 'Replace All', 'Skip'] : ['Replace', 'Skip'];
  const choice = await vscode.window.showWarningMessage(`${name} already exists in ${shortenHomePath(dir)}.`, { modal: true }, ...options);
  if (choice === 'Replace') return 'replace';
  if (choice === 'Replace All') return 'replaceAll';
  if (choice === 'Skip') return 'skip';
  return 'cancel';
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
