// isPidAlive adapted from vswt (MIT, (c) 2026 Vana Savych).
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { LiveKind, LiveSession, LiveStatus } from '../model/types';
import { sessionsDir } from '../paths';

const KINDS: ReadonlySet<string> = new Set<LiveKind>(['interactive', 'bg', 'daemon', 'daemon-worker']);
const STATUSES: ReadonlySet<string> = new Set<LiveStatus>(['busy', 'idle', 'waiting']);

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = gone; EPERM = exists but not ours to signal (still alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Live Claude processes per ~/.claude/sessions/<pid>.json, stale pid files filtered out. */
export async function readRegistry(dir = sessionsDir()): Promise<LiveSession[]> {
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter(f => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const out: LiveSession[] = [];
  await Promise.all(
    files.map(async f => {
      const full = path.join(dir, f);
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(await fs.readFile(full, 'utf8')) as Record<string, unknown>;
      } catch {
        return;
      }
      const live = toLive(o, full);
      if (live && isPidAlive(live.pid)) out.push(live);
    })
  );
  return out;
}

function toLive(o: Record<string, unknown>, registryPath: string): LiveSession | null {
  const pid = num(o['pid']);
  const sessionId = str(o['sessionId']);
  const cwd = str(o['cwd']);
  if (pid === null || !sessionId || !cwd) return null;
  const kindRaw = str(o['kind']) ?? 'interactive';
  const statusRaw = str(o['status']) ?? 'idle';
  const startedAt = num(o['startedAt']) ?? Date.now();
  const formerRaw = Array.isArray(o['formerNames']) ? (o['formerNames'] as unknown[]) : [];
  const formerNames: LiveSession['formerNames'] = [];
  for (const fn of formerRaw) {
    if (!fn || typeof fn !== 'object') continue;
    const r = fn as Record<string, unknown>;
    const name = str(r['name']);
    if (!name) continue;
    const sid = str(r['sessionId']);
    formerNames.push({ name, until: num(r['until']) ?? 0, ...(sid ? { sessionId: sid } : {}) });
  }
  return {
    pid,
    sessionId,
    cwd,
    kind: (KINDS.has(kindRaw) ? kindRaw : 'interactive') as LiveKind,
    name: str(o['name']),
    nameSource: str(o['nameSource']),
    status: (STATUSES.has(statusRaw) ? statusRaw : 'idle') as LiveStatus,
    waitingFor: str(o['waitingFor']),
    startedAt,
    statusUpdatedAt: num(o['statusUpdatedAt']) ?? num(o['updatedAt']) ?? startedAt,
    updatedAt: num(o['updatedAt']) ?? startedAt,
    version: str(o['version']),
    formerNames,
    registryPath
  };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
