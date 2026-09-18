// Head/tail scanning approach adapted from vswt's SessionScanner (MIT, (c) 2026 Vana Savych),
// extended with tail metadata (latest ai-title, last human prompt, end_turn, pending questions).
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { projectsDir, realpathSafe } from '../paths';

/** Only the head of each transcript is read for identity; metadata lives in the first records. */
const HEAD_BYTES = 256 * 1024;
/** Tail window for turn state; widened when it holds no user/assistant record. */
const TAIL_BYTES = 64 * 1024;
const TAIL_BYTES_WIDE = 768 * 1024;
const MAX_CONCURRENCY = 8;

export interface TranscriptHead {
  id: string;
  filePath: string;
  cwd: string;
  gitBranch: string | null;
  firstMessage: string | null;
  createdAt: number | null;
  /** ai-title seen in the head (fallback when the tail has none). */
  headTitle: string | null;
  mtimeMs: number;
  size: number;
}

export interface TranscriptTail {
  aiTitle: string | null;
  lastPrompt: string | null;
  agentName: string | null;
  gitBranch: string | null;
  lastUserTs: number | null;
  lastEndTurnTs: number | null;
  lastAssistantText: string | null;
  pendingQuestion: boolean;
  prLink: { number: number; url: string } | null;
}

interface HeadCache {
  key: string;
  /** null = parsed but unusable (no cwd); cached so it is not re-read every build. */
  head: TranscriptHead | null;
}
interface IndexEntry {
  filePath: string;
  mtimeMs: number;
  size: number;
}
/** Full re-list of the projects dir, as a safety net for missed watcher events. */
const FULL_RESCAN_MS = 10 * 60 * 1000;
interface TailCache {
  key: string;
  tail: TranscriptTail;
}

export class TranscriptScanner {
  private readonly heads = new Map<string, HeadCache>();
  private readonly tails = new Map<string, TailCache>();
  private readonly realpaths = new Map<string, string>();
  private index: Map<string, IndexEntry> | null = null;
  private indexedAt = 0;
  private readonly dirty = new Set<string>();
  private readonly dirtyDirs = new Set<string>();

  constructor(private readonly root: string = projectsDir()) {}

  /** Watcher hook: this transcript was created or changed; stat it on the next build. */
  markDirty(filePath: string): void {
    this.dirty.add(filePath);
  }

  /** Watcher hook / safety net: re-list one project directory on the next build. */
  markDirDirty(dir: string): void {
    this.dirtyDirs.add(dir);
  }

  /** Project dir Claude Code uses for a cwd (separators and dots become dashes). */
  projectDirFor(cwd: string): string {
    return path.join(this.root, cwd.replace(/[\/:.]/g, '-'));
  }

  hasTranscript(sessionId: string): boolean {
    if (!this.index) return false;
    for (const k of this.index.keys()) if (path.basename(k, '.jsonl') === sessionId) return true;
    return false;
  }

  /** Force a full re-list on the next build. */
  invalidateIndex(): void {
    this.index = null;
  }

  /**
   * Transcript paths with (mtime,size). After the first full listing, only files the watcher
   * flagged are stat'ed again, so a steady-state build costs a handful of fs calls even when the
   * extension host's I/O pool is contended.
   */
  async listTranscripts(): Promise<IndexEntry[]> {
    const now = Date.now();
    if (!this.index || now - this.indexedAt > FULL_RESCAN_MS) {
      this.index = new Map((await this.listAll()).map(e => [e.filePath, e]));
      this.indexedAt = now;
      this.dirty.clear();
      this.dirtyDirs.clear();
      return [...this.index.values()];
    }
    const index = this.index;
    const dirs = [...this.dirtyDirs];
    this.dirtyDirs.clear();
    await Promise.all(
      dirs.map(async dir => {
        for (const e of await this.listDir(dir)) index.set(e.filePath, e);
      })
    );
    const files = [...this.dirty];
    this.dirty.clear();
    await mapLimit(files, MAX_CONCURRENCY, async filePath => {
      try {
        const st = await fs.stat(filePath);
        if (st.isFile() && st.size > 0) index.set(filePath, { filePath, mtimeMs: st.mtimeMs, size: st.size });
        else index.delete(filePath);
      } catch {
        index.delete(filePath);
        this.forget(filePath);
      }
    });
    return [...index.values()];
  }

  private async listDir(dir: string): Promise<IndexEntry[]> {
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter(n => n.endsWith('.jsonl'));
    } catch {
      return [];
    }
    const out: IndexEntry[] = [];
    await Promise.all(
      names.map(async n => {
        const filePath = path.join(dir, n);
        try {
          const st = await fs.stat(filePath);
          if (st.isFile() && st.size > 0) out.push({ filePath, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* vanished */
        }
      })
    );
    return out;
  }

  private async listAll(): Promise<IndexEntry[]> {
    let dirs: string[];
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      dirs = entries.filter(e => e.isDirectory()).map(e => path.join(this.root, e.name));
    } catch {
      return [];
    }
    const out: IndexEntry[] = [];
    await mapLimit(dirs, MAX_CONCURRENCY, async dir => {
      out.push(...(await this.listDir(dir)));
    });
    return out;
  }

  async readHead(filePath: string, mtimeMs: number, size: number): Promise<TranscriptHead | null> {
    const key = `${mtimeMs}:${size}`;
    const cached = this.heads.get(filePath);
    // Head content only grows; identity fields never change, so any cached head is valid.
    // A null head (no cwd yet) is retried only while the file is still tiny.
    if (cached && (cached.head !== null || size >= HEAD_BYTES)) return cached.head;
    const text = await readWindow(filePath, 0, Math.min(size, HEAD_BYTES));
    if (text === null) return null;
    const head = parseHead(text, filePath, mtimeMs, size);
    this.heads.set(filePath, { key, head });
    return head;
  }

  async readTail(filePath: string, mtimeMs: number, size: number): Promise<TranscriptTail | null> {
    const key = `${mtimeMs}:${size}`;
    const cached = this.tails.get(filePath);
    if (cached && cached.key === key) return cached.tail;
    let tail = await this.readTailWindow(filePath, size, TAIL_BYTES);
    if (tail && !tail.sawTurnRecord && size > TAIL_BYTES) {
      tail = await this.readTailWindow(filePath, size, TAIL_BYTES_WIDE);
    }
    if (!tail) return null;
    this.tails.set(filePath, { key, tail });
    return tail;
  }

  private async readTailWindow(filePath: string, size: number, bytes: number) {
    const readSize = Math.min(size, bytes);
    const text = await readWindow(filePath, size - readSize, readSize);
    if (text === null) return null;
    const lines = text.split(/\r?\n/);
    if (size > readSize && lines.length > 1) lines.shift(); // first line is a fragment
    return parseTail(lines);
  }

  async realpath(p: string): Promise<string> {
    const c = this.realpaths.get(p);
    if (c) return c;
    const r = await realpathSafe(p);
    this.realpaths.set(p, r);
    return r;
  }

  forget(filePath: string): void {
    this.heads.delete(filePath);
    this.tails.delete(filePath);
    this.index?.delete(filePath);
    this.dirty.delete(filePath);
  }

  prune(existing: Set<string>): void {
    for (const k of [...this.heads.keys()]) if (!existing.has(k)) this.heads.delete(k);
    for (const k of [...this.tails.keys()]) if (!existing.has(k)) this.tails.delete(k);
  }
}

/** Run async tasks with a concurrency cap. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}
export const CONCURRENCY = MAX_CONCURRENCY;

async function readWindow(filePath: string, offset: number, length: number): Promise<string | null> {
  if (length <= 0) return '';
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

type Rec = Record<string, unknown>;

function parseLine(raw: string): Rec | null {
  const line = raw.trim();
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? (parsed as Rec) : null;
  } catch {
    return null;
  }
}

function parseHead(text: string, filePath: string, mtimeMs: number, size: number): TranscriptHead | null {
  let id: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let firstMessage: string | null = null;
  let createdAt: number | null = null;
  let headTitle: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const o = parseLine(raw);
    if (!o) continue;
    if (!id) id = str(o['sessionId']);
    if (!cwd) cwd = str(o['cwd']);
    if (!gitBranch) gitBranch = str(o['gitBranch']);
    if (createdAt === null) createdAt = ts(o['timestamp']);
    if (o['type'] === 'ai-title') headTitle = str(o['aiTitle']) ?? headTitle;
    if (!firstMessage && isHumanUser(o)) firstMessage = humanText(o);
    if (id && cwd && firstMessage && createdAt !== null) break;
  }
  if (!cwd) return null;
  return {
    id: id ?? path.basename(filePath, '.jsonl'),
    filePath,
    cwd,
    gitBranch,
    firstMessage,
    createdAt,
    headTitle,
    mtimeMs,
    size
  };
}

function parseTail(lines: string[]): TranscriptTail & { sawTurnRecord: boolean } {
  let aiTitle: string | null = null;
  let lastPrompt: string | null = null;
  let agentName: string | null = null;
  let gitBranch: string | null = null;
  let lastUserTs: number | null = null;
  let lastEndTurnTs: number | null = null;
  let lastAssistantText: string | null = null;
  let prLink: TranscriptTail['prLink'] = null;
  let sawTurnRecord = false;
  const openQuestions = new Map<string, number>(); // tool_use_id → ts
  const answered = new Set<string>();

  for (const raw of lines) {
    const o = parseLine(raw);
    if (!o) continue;
    const type = o['type'];
    const b = str(o['gitBranch']);
    if (b) gitBranch = b;
    switch (type) {
      case 'ai-title':
        aiTitle = str(o['aiTitle']) ?? aiTitle;
        break;
      case 'last-prompt':
        lastPrompt = str(o['lastPrompt']) ?? lastPrompt;
        break;
      case 'agent-name':
        agentName = str(o['agentName']) ?? agentName;
        break;
      case 'pr-link': {
        const n = typeof o['prNumber'] === 'number' ? (o['prNumber'] as number) : null;
        const url = str(o['prUrl']);
        if (n !== null && url) prLink = { number: n, url };
        break;
      }
      case 'user': {
        sawTurnRecord = true;
        const t = ts(o['timestamp']);
        if (isHumanUser(o)) {
          if (t !== null) lastUserTs = t;
        }
        for (const id of toolResultIds(o)) answered.add(id);
        break;
      }
      case 'assistant': {
        sawTurnRecord = true;
        const msg = o['message'];
        const t = ts(o['timestamp']);
        if (msg && typeof msg === 'object') {
          const m = msg as Rec;
          const text = assistantText(m);
          if (text) lastAssistantText = text;
          if (m['stop_reason'] === 'end_turn' && t !== null) lastEndTurnTs = t;
          for (const id of askUserQuestionIds(m)) openQuestions.set(id, t ?? 0);
        }
        break;
      }
      case 'system': {
        // Stop-hook summary is written when a turn ends; treat as end-of-turn evidence.
        if (o['subtype'] === 'stop_hook_summary') {
          const t = ts(o['timestamp']);
          if (t !== null && (lastEndTurnTs === null || t > lastEndTurnTs)) lastEndTurnTs = t;
        }
        break;
      }
      default:
        break;
    }
  }
  let pendingQuestion = false;
  for (const [id, t] of openQuestions) {
    if (answered.has(id)) continue;
    if (lastUserTs !== null && t < lastUserTs) continue; // superseded by a later human prompt
    pendingQuestion = true;
  }
  return {
    aiTitle,
    lastPrompt,
    agentName,
    gitBranch,
    lastUserTs,
    lastEndTurnTs,
    lastAssistantText,
    pendingQuestion,
    prLink,
    sawTurnRecord
  };
}

/** A user record typed by a human (not a tool_result, not an injected meta/system message). */
function isHumanUser(o: Rec): boolean {
  if (o['type'] !== 'user') return false;
  if (o['isMeta'] === true || o['isSidechain'] === true) return false;
  const origin = o['origin'];
  if (origin && typeof origin === 'object' && (origin as Rec)['kind'] === 'human') return true;
  const msg = o['message'];
  if (!msg || typeof msg !== 'object') return false;
  const content = (msg as Rec)['content'];
  if (typeof content === 'string') return cleanText(content) !== null;
  if (!Array.isArray(content)) return false;
  let hasText = false;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Rec;
    if (p['type'] === 'tool_result') return false;
    if (p['type'] === 'text' && typeof p['text'] === 'string' && cleanText(p['text'])) hasText = true;
  }
  return hasText;
}

function humanText(o: Rec): string | null {
  const msg = o['message'];
  if (!msg || typeof msg !== 'object') return null;
  const content = (msg as Rec)['content'];
  if (typeof content === 'string') return cleanText(content);
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && (part as Rec)['type'] === 'text') {
        const t = cleanText(String((part as Rec)['text'] ?? ''));
        if (t) return t;
      }
    }
  }
  return null;
}

/** Skip tool/command/system-wrapped messages so the label is a real prompt. */
function cleanText(s: string): string | null {
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t || t.startsWith('<')) return null;
  return t.replace(/^❯\s*/, '');
}

function assistantText(m: Rec): string | null {
  const content = m['content'];
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object' && (part as Rec)['type'] === 'text') {
      const t = (part as Rec)['text'];
      if (typeof t === 'string' && t.trim()) parts.push(t.trim());
    }
  }
  return parts.length ? parts.join('\n') : null;
}

function askUserQuestionIds(m: Rec): string[] {
  const content = m['content'];
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Rec;
    if (p['type'] === 'tool_use' && p['name'] === 'AskUserQuestion' && typeof p['id'] === 'string') ids.push(p['id']);
  }
  return ids;
}

function toolResultIds(o: Rec): string[] {
  const msg = o['message'];
  if (!msg || typeof msg !== 'object') return [];
  const content = (msg as Rec)['content'];
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Rec;
    if (p['type'] === 'tool_result' && typeof p['tool_use_id'] === 'string') ids.push(p['tool_use_id']);
  }
  return ids;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}
function ts(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}
