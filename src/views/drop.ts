import * as vscode from 'vscode';
import type { Hub } from '../hub';
import { uploadInto } from '../fs/upload';
import type { DroppedData } from '../fs/upload';
import type { Node } from './nodes';
import { dirOf } from './nodes';

/**
 * Drops onto folder-like rows (repo, folder, Browse files, a directory inside it) copy the
 * dragged files there: paths from the Explorer or Finder arrive as `text/uri-list`, external
 * drops without a path as `files`. Nothing is draggable out of the tree.
 */
export class FsDropController implements vscode.TreeDragAndDropController<Node> {
  readonly dropMimeTypes = ['text/uri-list', 'files'];
  readonly dragMimeTypes: string[] = [];

  constructor(private readonly hub: Hub) {}

  async handleDrop(target: Node | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const dir = dirOf(target);
    if (!dir) return;
    const uris: vscode.Uri[] = [];
    const list = await dataTransfer.get('text/uri-list')?.asString();
    if (list) {
      for (const line of list.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        try {
          const u = vscode.Uri.parse(t);
          if (u.scheme === 'file') uris.push(u);
        } catch {
          /* not a uri */
        }
      }
    }
    const dropped: DroppedData[] = [];
    dataTransfer.forEach((item, mime) => {
      if (mime === 'text/uri-list') return;
      const f = item.asFile();
      if (!f) return;
      if (f.uri?.scheme === 'file') {
        if (!uris.some(u => u.fsPath === f.uri?.fsPath)) uris.push(f.uri);
        return;
      }
      dropped.push({ name: f.name, data: () => f.data() });
    });
    // A file dropped onto its own folder is a no-op, not an overwrite prompt.
    const sources = uris.filter(u => u.fsPath !== dir && u.fsPath.slice(0, u.fsPath.lastIndexOf('/')) !== dir);
    if (sources.length === 0 && dropped.length === 0) return;
    const n = await uploadInto(dir, sources, dropped);
    if (n > 0) this.hub.invalidateDir(dir);
  }
}
