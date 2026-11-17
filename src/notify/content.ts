import * as path from 'node:path';
import type { QueueItem } from '../model/types';
import { displayName } from '../model/types';

export interface NotificationContent {
  /** "Needs input · <repo>" / "Finished · <repo>". */
  title: string;
  /** Session name, plus the branch when known. */
  subtitle: string;
  /** What the session wants: the pending question, the permission it waits on, or how the turn ended. */
  message: string;
}

const MAX_MESSAGE = 180;

/** Repo (or folder) a queue item belongs to, for the notification title. */
export function repoLabel(q: QueueItem): string {
  const dir = q.session?.repoRoot ?? q.session?.cwdReal ?? q.live?.cwd ?? q.job?.cwd ?? null;
  return dir ? path.basename(dir) || dir : 'Claude';
}

export function notificationContent(q: QueueItem): NotificationContent {
  const repo = repoLabel(q);
  const name = q.job && !q.session ? q.job.name ?? q.job.short : displayName(q.session, q.live, q.sessionId);
  const branch = q.session?.gitBranch;
  const subtitle = branch ? `${name} · ${branch}` : name;
  if (q.kind === 'needsInput') {
    return { title: `Needs input · ${repo}`, subtitle, message: clip(needsInputMessage(q)) };
  }
  return { title: `Finished · ${repo}`, subtitle, message: clip(finishedMessage(q)) };
}

function needsInputMessage(q: QueueItem): string {
  const question = q.session?.pendingQuestionText;
  if (question) return `Asks: ${question}`;
  const waiting = q.live?.waitingFor?.trim();
  if (waiting) return `Waiting on ${waiting}`;
  return q.reason && q.reason !== 'input needed' ? q.reason : 'Waiting for your input';
}

function finishedMessage(q: QueueItem): string {
  if (q.job && !q.live) {
    const detail = q.job.detail?.trim();
    return detail ? `Background job ${q.job.state}: ${firstLine(detail)}` : `Background job ${q.job.state}`;
  }
  const last = q.session?.lastAssistantText?.trim();
  return last ? firstLine(last) : 'Turn finished, ready for review';
}

function firstLine(s: string): string {
  const line = s.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
  return line.replace(/^#+\s*/, '').replace(/\*\*/g, '');
}

function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > MAX_MESSAGE ? `${one.slice(0, MAX_MESSAGE - 1)}…` : one;
}

/** Key shared by every window for one notification-worthy event (used to elect a single sender). */
export function eventKey(q: QueueItem): string {
  return q.reviewKey ?? `${q.sessionId}:${q.kind}:${q.since}`;
}
