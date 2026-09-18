import { descendants, processTree } from '../src/terminals/adopt';
import { readRegistry } from '../src/sources/registry';
async function main() {
  const [tree, live] = await Promise.all([processTree(), readRegistry()]);
  console.log(`process tree: ${tree.size} parents; live claude pids: ${live.map(l => l.pid).join(', ')}`);
  // find each live pid's ancestors to show which shell would adopt it
  const parentOf = new Map<number, number>();
  for (const [ppid, kids] of tree) for (const k of kids) parentOf.set(k, ppid);
  for (const l of live) {
    const chain: number[] = [];
    let p: number | undefined = l.pid;
    for (let i = 0; i < 6 && p !== undefined && p > 1; i++) { chain.push(p); p = parentOf.get(p); }
    const shell = chain[1];
    const ok = shell !== undefined && descendants(tree, shell).has(l.pid);
    console.log(`  ${l.pid} (${l.name}) ancestry: ${chain.join(' ← ')}  adoptable-from-parent=${ok}`);
  }
}
main();
