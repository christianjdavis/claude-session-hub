import { execFile } from 'node:child_process';

/** pid → children, from one `ps` call (macOS/Linux). Runs in the worker: spawning from the extension host waits on its event loop. */
export async function processTree(): Promise<Map<number, number[]>> {
  const out = await run('ps', ['-axo', 'pid=,ppid=']);
  const children = new Map<number, number[]>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const arr = children.get(ppid);
    if (arr) arr.push(pid);
    else children.set(ppid, [pid]);
  }
  return children;
}

/** All descendants of `pid` up to `depth` levels. */
export function descendants(tree: Map<number, number[]>, pid: number, depth = 4): Set<number> {
  const out = new Set<number>();
  let frontier = [pid];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: number[] = [];
    for (const p of frontier) {
      for (const c of tree.get(p) ?? []) {
        if (!out.has(c)) {
          out.add(c);
          next.push(c);
        }
      }
    }
    frontier = next;
  }
  return out;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise(resolve => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}
