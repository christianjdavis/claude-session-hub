import { isTerminalJobState } from '../sources/jobs';
import type { BgJob, Counts, LiveSession, QueueItem, Session } from '../model/types';
import { primaryLive } from '../model/types';

export interface QueueInput {
  live: Map<string, LiveSession[]>;
  sessions: Map<string, Session>;
  jobs: BgJob[];
  reviewed: Set<string>;
  /** Ignore finished background jobs older than this (ms). */
  jobMaxAgeMs: number;
  now: number;
}

export function reviewKeyFor(sessionId: string, session: Session | null, live: LiveSession): string {
  const ts = session?.lastEndTurnTs ?? live.statusUpdatedAt;
  return `${sessionId}:${ts}`;
}

export function jobReviewKey(job: BgJob): string {
  return `bg:${job.short}:${job.updatedAt}`;
}

/** True when the transcript shows Claude finished a turn after the user's last prompt. */
export function turnCompleted(session: Session | null, live: LiveSession): boolean {
  if (session && session.lastEndTurnTs !== null) {
    if (session.lastUserTs === null) return true;
    return session.lastEndTurnTs > session.lastUserTs;
  }
  // No tail evidence: the registry alone can only tell us it went idle after some work,
  // which also describes a freshly started session. Require a real prompt first.
  if (session && session.lastUserTs !== null) return live.statusUpdatedAt > session.lastUserTs;
  return false;
}

export function deriveQueue(input: QueueInput): { queue: QueueItem[]; counts: Counts } {
  const needsInput: QueueItem[] = [];
  const review: QueueItem[] = [];
  const running: QueueItem[] = [];
  let idle = 0;

  for (const [sessionId, list] of input.live) {
    const live = primaryLive(list);
    if (!live || live.kind !== 'interactive') continue;
    const session = input.sessions.get(sessionId) ?? null;
    const base = { sessionId, live, session, job: null };

    if (live.status === 'waiting') {
      needsInput.push({ ...base, kind: 'needsInput', reason: live.waitingFor ?? 'input needed', since: live.statusUpdatedAt });
      continue;
    }
    if (live.status === 'busy') {
      running.push({ ...base, kind: 'running', reason: 'working', since: live.statusUpdatedAt });
      continue;
    }
    // idle
    if (session?.pendingQuestion) {
      needsInput.push({ ...base, kind: 'needsInput', reason: 'question pending', since: live.statusUpdatedAt });
      continue;
    }
    if (turnCompleted(session, live)) {
      const reviewKey = reviewKeyFor(sessionId, session, live);
      if (!input.reviewed.has(reviewKey)) {
        review.push({
          ...base,
          kind: 'review',
          reason: 'finished',
          since: session?.lastEndTurnTs ?? live.statusUpdatedAt,
          reviewKey
        });
        continue;
      }
    }
    idle++;
  }

  for (const job of input.jobs) {
    if (!isTerminalJobState(job.state)) continue;
    if (input.now - job.updatedAt > input.jobMaxAgeMs) continue;
    const reviewKey = jobReviewKey(job);
    if (input.reviewed.has(reviewKey)) continue;
    const session = job.sessionId ? input.sessions.get(job.sessionId) ?? null : null;
    review.push({
      kind: 'review',
      sessionId: job.sessionId ?? `bg:${job.short}`,
      live: job.live,
      session,
      job,
      reason: `background ${job.state}`,
      since: job.updatedAt,
      reviewKey
    });
  }

  needsInput.sort((a, b) => a.since - b.since); // oldest wait first
  review.sort((a, b) => b.since - a.since); // newest finish first
  running.sort((a, b) => a.live!.startedAt - b.live!.startedAt);

  return {
    queue: [...needsInput, ...review, ...running],
    counts: { needsInput: needsInput.length, review: review.length, running: running.length, idle }
  };
}
