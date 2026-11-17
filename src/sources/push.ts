import { execFile, spawn } from 'node:child_process';

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
  /** The push as a shell command (shown in the confirmation, used by the terminal fallback); null when there is nothing pushable. */
  command: string | null;
  /** The same push as git arguments, for running it directly. */
  args: string[] | null;
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
  const args = !branch || !remote ? null : upstream ? ['push'] : ['push', '-u', remote, 'HEAD'];
  const command = args ? ['git', ...args].map(shellQuote).join(' ') : null;
  return { repoRoot, branch, upstream, remote, ahead, behind, isDefaultBranch, command, args };
}

export interface PushResult {
  /** git's exit code; null when it was cancelled or timed out. */
  code: number | null;
  /** Combined stdout and stderr, as git printed it. */
  output: string;
  /** Merge/pull request link the remote printed (GitLab, GitHub), if any. */
  reviewUrl: string | null;
  /** True when the review link is to an existing merge/pull request rather than a "create" page. */
  reviewExists: boolean;
}

const PUSH_TIMEOUT_MS = 3 * 60_000;

/**
 * Run `git <args>` in the repo without a terminal. Credential prompts cannot be answered here, so they are
 * turned off (GIT_TERMINAL_PROMPT=0) and fail fast instead of hanging; helpers, keychains and SSH agents work.
 */
export function runPush(repoRoot: string, args: string[], opts: { onOutput?: (chunk: string) => void; signal?: AbortSignal } = {}): Promise<PushResult> {
  return new Promise(resolve => {
    const child = spawn('git', ['-C', repoRoot, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const onData = (b: Buffer) => {
      const chunk = b.toString();
      output += chunk;
      opts.onOutput?.(chunk);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const kill = () => child.kill('SIGTERM');
    const timer = setTimeout(kill, PUSH_TIMEOUT_MS);
    opts.signal?.addEventListener('abort', kill);
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', kill);
      resolve({ code, output, ...reviewLink(output) });
    };
    child.on('error', err => {
      output += String(err);
      finish(-1);
    });
    child.on('close', (code, sig) => finish(sig ? null : code));
  });
}

/** Find the merge/pull request link in `remote:` lines (GitLab "create"/"view merge request", GitHub "pull/new"). */
export function reviewLink(output: string): { reviewUrl: string | null; reviewExists: boolean } {
  const lines = output.split(/\r?\n/).filter(l => l.startsWith('remote:'));
  for (let i = 0; i < lines.length; i++) {
    const url = /(https?:\/\/\S+)/.exec(lines[i]!)?.[1];
    if (!url || !/merge_requests|\/pull\//.test(url)) continue;
    const context = `${lines[i - 1] ?? ''} ${lines[i]}`.toLowerCase();
    const exists = /view merge request|\/merge_requests\/\d+|\/pull\/\d+/.test(context);
    return { reviewUrl: url, reviewExists: exists };
  }
  return { reviewUrl: null, reviewExists: false };
}

/** Most useful line of a failed push for a one-line error (git's `error:`/`fatal:`/`!` rejection lines). */
export function pushErrorSummary(output: string): string {
  const lines = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const pick = lines.find(l => /^(fatal|error):/i.test(l)) ?? lines.find(l => l.startsWith('! ')) ?? lines.find(l => /^remote: (error|GitLab:)/i.test(l)) ?? lines[lines.length - 1];
  return pick ?? 'git push failed';
}

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise(resolve => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
