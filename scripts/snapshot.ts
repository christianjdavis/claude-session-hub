// Dev harness: build a snapshot from the real ~/.claude data and print a summary with timings.
import * as os from 'node:os';
import * as path from 'node:path';
import { displayName, primaryLive } from '../src/model/types';
import { formatRelativeTime } from '../src/format';
import { MemoryStore, ReviewedStore } from '../src/state/reviewed-store';
import { SessionStore } from '../src/state/store';

async function main() {
  const roots = process.argv.slice(2).length ? process.argv.slice(2) : [path.join(os.homedir(), 'dev')];
  const reviewed = new ReviewedStore(new MemoryStore());
  const store = new SessionStore();
  const opts = { roots, maxAgeDays: 14, maxPerRepo: 20, repoScanDepth: 4, reviewedKeys: reviewed.keys() };

  let t0 = performance.now();
  let snap = await store.build(opts);
  const cold = performance.now() - t0;
  t0 = performance.now();
  snap = await store.build(opts);
  const warm = performance.now() - t0;

  console.log(`cold ${cold.toFixed(0)} ms, warm ${warm.toFixed(0)} ms`);
  console.log(`sessions ${snap.sessions.size}, live ${snap.live.size}, jobs ${snap.jobs.length}, repos ${snap.repos.length}, other ${snap.other.length}`);
  console.log('counts', snap.counts);
  console.log('\nQUEUE');
  for (const q of snap.queue) {
    const name = displayName(q.session, q.live);
    console.log(`  [${q.kind}] ${name}  · ${q.reason} · ${formatRelativeTime(q.since)} · ${q.session?.cwd ?? q.live?.cwd ?? ''}`);
  }
  console.log('\nLIVE');
  for (const [id, list] of snap.live) {
    const l = primaryLive(list)!;
    const s = snap.sessions.get(id);
    console.log(`  ${l.status.padEnd(7)} ${l.kind.padEnd(11)} ${displayName(s ?? null, l)}  · ${l.cwd}`);
    if (s) console.log(`          lastUser=${s.lastUserTs ? new Date(s.lastUserTs).toISOString() : '-'} lastEndTurn=${s.lastEndTurnTs ? new Date(s.lastEndTurnTs).toISOString() : '-'} pendingQ=${s.pendingQuestion} title=${s.aiTitle}`);
  }
  console.log('\nREPOS');
  for (const r of snap.repos.slice(0, 25)) {
    console.log(`  ${r.relPath.padEnd(60)} live=${r.liveCount} sessions=${r.sessions.length} git=${r.isGit}`);
    for (const s of r.sessions.slice(0, 3)) console.log(`      - ${displayName(s, primaryLive(snap.live.get(s.id)))} (${formatRelativeTime(s.lastActivity)}) ${s.gitBranch ?? ''}`);
  }
  if (snap.repos.length > 25) console.log(`  … ${snap.repos.length - 25} more`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
