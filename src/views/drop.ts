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

const PIN_MIME = 'application/vnd.code.tree.sessionhub.pin';

/**
 * Focus view: pinned repo/folder rows can be dragged onto each other to reorder; anything else
 * dropped there (Finder files, Explorer paths) is an upload handled by the wrapped controller.
 */
export class PinDropController implements vscode.TreeDragAndDropController<Node> {
  readonly dropMimeTypes = [PIN_MIME, 'text/uri-list', 'files'];
  readonly dragMimeTypes = [PIN_MIME];

  constructor(
    private readonly hub: Hub,
    private readonly inner: FsDropController
  ) {}

  handleDrag(sources: readonly Node[], dataTransfer: vscode.DataTransfer): void {
    const paths: string[] = [];
    for (const n of sources) {
      if (n.kind !== 'repo' && n.kind !== 'folder') return;
      const p = dirOf(n);
      if (!p || !this.hub.pins.has(p)) return;
      paths.push(p);
    }
    if (paths.length) dataTransfer.set(PIN_MIME, new vscode.DataTransferItem(paths));
  }

  async handleDrop(target: Node | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const item = dataTransfer.get(PIN_MIME);
    if (!item) return this.inner.handleDrop(target, dataTransfer);
    const paths = (item.value as unknown[] | undefined) ?? [];
    let before: string | null = null;
    if (target) {
      if (target.kind !== 'repo' && target.kind !== 'folder') return;
      before = dirOf(target);
      if (!before || !this.hub.pins.has(before)) return;
    }
    for (const p of paths) if (typeof p === 'string') await this.hub.movePinBefore(p, before);
  }
}
