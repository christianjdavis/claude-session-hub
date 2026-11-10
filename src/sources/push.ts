import { execFile } from 'node:child_process';

/** What a push from the hub would do, read before asking the user to confirm. */
export interface PushPlan {
  repoRoot: string;
  /** Current branch, null when HEAD is detached. */
  branch: string | null;
  /** `origin/feature`, or null when the branch has no upstream yet. */
  upstream: string | null;
  /** Remote a first push sets as upstream: `origin`, else the only/first remote. Null: no remotes. */
  remote: string | null;
  /** Commits not on the upstream yet; null when there is no upstream to compare against. */
  ahead: number | null;
  /** Commits on the upstream not merged locally (the push would be rejected as non-fast-forward). */
  behind: number | null;
  /** The branch is the remote's default branch (origin/HEAD), or main/master when that is unknown. */
  isDefaultBranch: boolean;
  /** Shell command to run in the terminal, or null when there is nothing pushable. */
  command: string | null;
}

export async function planPush(repoRoot: string): Promise<PushPlan> {
  const git = (...args: string[]) => run('git', ['-C', repoRoot, '--no-optional-locks', ...args]);
  const branch = (await git('symbolic-ref', '-q', '--short', 'HEAD'))?.trim() || null;
  const upstream = branch ? (await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'))?.trim() || null : null;
  const remotes = ((await git('remote')) ?? '').split('\n').map(r => r.trim()).filter(Boolean);
  const remote = upstream ? upstream.slice(0, upstream.indexOf('/')) : remotes.includes('origin') ? 'origin' : (remotes[0] ?? null);

  let ahead: number | null = null;
  let behind: number | null = null;
  if (upstream) {
    const counts = (await git('rev-list', '--left-right', '--count', `${upstream}...HEAD`))?.trim().split(/\s+/);
    if (counts?.length === 2) {
      behind = Number(counts[0]);
      ahead = Number(counts[1]);
    }
  }

  const head = remote ? (await git('symbolic-ref', '-q', '--short', `refs/remotes/${remote}/HEAD`))?.trim() : undefined;
  const defaultBranch = head ? head.slice(head.indexOf('/') + 1) : null;
  const isDefaultBranch = !!branch && (defaultBranch ? branch === defaultBranch : branch === 'main' || branch === 'master');

  // `-u <remote> HEAD` on a first push, so the branch tracks what it was pushed to; plain `push` after.
  const command = !branch || !remote ? null : upstream ? 'git push' : `git push -u ${shellQuote(remote)} HEAD`;
  return { repoRoot, branch, upstream, remote, ahead, behind, isDefaultBranch, command };
}

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise(resolve => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
