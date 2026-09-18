/** One transcript file under ~/.claude/projects/<encoded-cwd>/<id>.jsonl. */
export interface Session {
  id: string;
  filePath: string;
  /** Working directory recorded in the transcript (never derived from the folder name). */
  cwd: string;
  /** realpath of cwd when resolvable, else cwd. */
  cwdReal: string;
  gitBranch: string | null;
  /** Latest `ai-title` record (the tail wins over the head). */
  aiTitle: string | null;
  lastPrompt: string | null;
  agentName: string | null;
  firstMessage: string | null;
  createdAt: number | null;
  /** File mtime (ms). */
  lastActivity: number;
  /** Timestamp of the last human-authored user record. */
  lastUserTs: number | null;
  /** Timestamp of the last assistant record with stop_reason === 'end_turn'. */
  lastEndTurnTs: number | null;
  /** Text of the last assistant message, for review summaries. */
  lastAssistantText: string | null;
  /** True if the transcript tail shows an AskUserQuestion tool_use without a result. */
  pendingQuestion: boolean;
  prLink: { number: number; url: string } | null;
  /** Nearest ancestor of cwdReal (up to the workspace root) that contains `.git`. */
  repoRoot: string | null;
  inWorkspace: boolean;
}

export type LiveKind = 'interactive' | 'bg' | 'daemon' | 'daemon-worker';
export type LiveStatus = 'busy' | 'idle' | 'waiting';

/** One ~/.claude/sessions/<pid>.json whose pid is alive. */
export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  kind: LiveKind;
  name: string | null;
  nameSource: string | null;
  status: LiveStatus;
  waitingFor: string | null;
  startedAt: number;
  statusUpdatedAt: number;
  updatedAt: number;
  version: string | null;
  formerNames: Array<{ name: string; until: number; sessionId?: string }>;
  registryPath: string;
  /** Background job this process runs (`kind: 'bg'`), from the registry. */
  jobId: string | null;
  /** Interactive UI process that handed its conversation to a bg worker with this job id. */
  parkedJobId: string | null;
  /** For a worker attached to a parked UI: the UI process pid (the terminal the user sees). */
  uiPid: number | null;
}

/** One ~/.claude/jobs/<short>/state.json. */
export interface BgJob {
  short: string;
  sessionId: string | null;
  cwd: string | null;
  name: string | null;
  state: string;
  detail: string | null;
  tempo: string | null;
  updatedAt: number;
  live: LiveSession | null;
}

export type QueueKind = 'needsInput' | 'review' | 'running';

export interface QueueItem {
  kind: QueueKind;
  sessionId: string;
  live: LiveSession | null;
  session: Session | null;
  job: BgJob | null;
  /** Human reason: waitingFor, 'finished', etc. */
  reason: string;
  /** When this state began (ms). */
  since: number;
  /** Present for review items; stable key persisted in the reviewed store. */
  reviewKey?: string;
}

export interface Repo {
  root: string;
  label: string;
  relPath: string;
  isGit: boolean;
  sessions: Session[];
  liveCount: number;
}

export interface Counts {
  needsInput: number;
  review: number;
  running: number;
  idle: number;
}

export interface Snapshot {
  at: number;
  sessions: Map<string, Session>;
  /** Live processes grouped by sessionId (a session resumed twice yields two). */
  live: Map<string, LiveSession[]>;
  jobs: BgJob[];
  repos: Repo[];
  /** Sessions whose cwd is outside every root. */
  other: Session[];
  queue: QueueItem[];
  counts: Counts;
  /** Build phase durations in ms (diagnostics). */
  timings?: Record<string, number>;
  /** Resolved (realpath) roots the snapshot was built for. */
  realRoots: string[];
}

export function emptySnapshot(): Snapshot {
  return {
    at: Date.now(),
    sessions: new Map(),
    live: new Map(),
    jobs: [],
    repos: [],
    other: [],
    queue: [],
    counts: { needsInput: 0, review: 0, running: 0, idle: 0 },
    realRoots: []
  };
}

/** Stable fingerprint of what the trees render; equal fingerprints mean no re-render is needed. */
export function fingerprint(snap: Snapshot): string {
  const parts: string[] = [];
  for (const q of snap.queue) parts.push(`q:${q.kind}:${q.sessionId}:${q.reviewKey ?? ''}:${q.reason}`);
  for (const [id, list] of snap.live) {
    const l = primaryLive(list);
    if (l) parts.push(`l:${id}:${l.status}:${l.waitingFor ?? ''}:${l.name ?? ''}:${list.length}:${l.uiPid ?? ''}`);
  }
  for (const j of snap.jobs) parts.push(`j:${j.short}:${j.state}`);
  for (const r of snap.repos) {
    parts.push(`r:${r.root}:${r.liveCount}:${r.sessions.map(s => `${s.id}${s.aiTitle ?? ''}${s.gitBranch ?? ''}`).join(',')}`);
  }
  parts.push(`o:${snap.other.map(s => s.id).join(',')}`);
  return parts.join('|');
}

/** Display-name precedence shared by trees, switcher and terminals. */
export function displayName(session: Session | null, live: LiveSession | null, fallbackId?: string): string {
  if (live?.name && live.nameSource !== 'derived') return live.name;
  if (session?.aiTitle) return session.aiTitle;
  if (session?.agentName) return session.agentName;
  if (live?.name) return live.name;
  if (session?.lastPrompt) return session.lastPrompt;
  if (session?.firstMessage) return session.firstMessage;
  const id = session?.id ?? live?.sessionId ?? fallbackId ?? '';
  return id.slice(0, 8) || 'session';
}

/** Primary live entry for a session: newest by updatedAt. */
export function primaryLive(list: LiveSession[] | undefined): LiveSession | null {
  if (!list || list.length === 0) return null;
  return list.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
}
