import { branchFiles, changedFilesFor, commitFiles, defaultBase, sessionCommits, sessionGroups } from '../src/sources/changes';
import type { ChangedFile } from '../src/sources/changes';
import { MemoryStore, ReviewedStore } from '../src/state/reviewed-store';
import { SessionStore } from '../src/state/store';
import * as os from 'node:os'; import * as path from 'node:path';
async function main() {
  const r = new ReviewedStore(new MemoryStore());
  const snap = await new SessionStore().build({ roots: [path.join(os.homedir(), 'dev')], maxAgeDays: 14, maxPerRepo: 20, repoScanDepth: 4, reviewedKeys: r.keys() });
  for (const [id] of snap.live) {
    const s = snap.sessions.get(id)!; const t0 = performance.now();
    const [files, commits] = await Promise.all([changedFilesFor(s), sessionCommits(s)]);
    console.log(`\n${id.slice(0,8)} ${s.aiTitle} [${s.gitBranch}] repo=${s.repoRoot ? path.basename(s.repoRoot) : '-'} — ${files.length} working files, ${commits.length} commits (${(performance.now()-t0).toFixed(0)} ms)`);
    for (const f of files.slice(0, 5)) console.log(`   wt ${f.status.padEnd(7)} ${f.path.replace(os.homedir(), '~')}`);
    for (const c of commits.slice(0, 4)) {
      const cf = await commitFiles(c);
      console.log(`   ${c.short} ${c.subject.slice(0, 60)} (${cf.length} files) e.g. ${cf.slice(0,2).map(f => f.status + ' ' + path.relative(c.repoRoot, f.path)).join(', ')}`);
    }
    if (s.repoRoot) {
      const base = await defaultBase(s.repoRoot);
      const br = base ? await branchFiles(s.repoRoot, base) : null;
      console.log(`   branch vs ${base}: ${br ? br.files.length + ' files, merge-base ' + br.mergeBase.slice(0, 8) : 'n/a'}`);
    }
    const t1 = performance.now();
    const g = await sessionGroups(s);
    const t2 = performance.now();
    await sessionGroups(s);
    console.log(`   sessionGroups: ${g.commits.length} commits, ${g.files.length} files changed since ${g.from?.slice(0, 10)}, branchCount=${g.branchCount} — first ${(t2 - t1).toFixed(0)} ms, repeat ${(performance.now() - t2).toFixed(1)} ms`);
    const where = (f: ChangedFile) => (f.inCommits && f.inWorkingTree ? 'committed+edited' : f.inCommits ? 'committed' : f.inWorkingTree ? 'uncommitted' : '-');
    for (const f of g.files.slice(0, 8)) console.log(`   fc ${f.status.padEnd(2)} ${where(f).padEnd(16)} ${f.path.replace(os.homedir(), '~')}${f.thisTurn ? '  (this turn)' : ''}`);
    if (g.files.length > 8) console.log(`   … ${g.files.length - 8} more`);
  }
}
main();
