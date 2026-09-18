import * as vscode from 'vscode';
import type { Hub } from '../hub';
import type { Node } from './nodes';
import type { ReposTreeProvider } from './repos-tree';

/**
 * "Focus" view: the repo/folder rows the user pinned, in pin order. Rows render and expand
 * exactly as in All available, so everything below the root delegates to that provider.
 */
export class FocusTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly hub: Hub,
    private readonly repos: ReposTreeProvider
  ) {
    hub.onDidChange(() => this.emitter.fire(undefined));
    hub.onDidChangePins(() => this.emitter.fire(undefined));
    hub.onDidChangeNode(node => this.emitter.fire(node));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return this.repos.getTreeItem(node);
  }

  getChildren(node?: Node): Promise<Node[]> | Node[] {
    if (node) return this.repos.getChildren(node);
    // Empty → the view's welcome text explains how to pin.
    return this.hub.pins.list().map(p => (p.kind === 'repo' ? this.repos.repoNode(p.path) : this.repos.folderNode(p.path)));
  }
}
