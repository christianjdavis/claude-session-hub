import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BgJob } from '../model/types';
import { jobsDir } from '../paths';

/** Background sessions (`claude --bg`) per ~/.claude/jobs/<short>/state.json. */
export async function readJobs(dir = jobsDir()): Promise<BgJob[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
  const out: BgJob[] = [];
  await Promise.all(
    entries.map(async short => {
      const p = path.join(dir, short, 'state.json');
      let o: Record<string, unknown>;
      let mtime = 0;
      try {
        const [text, st] = await Promise.all([fs.readFile(p, 'utf8'), fs.stat(p)]);
        o = JSON.parse(text) as Record<string, unknown>;
        mtime = st.mtimeMs;
      } catch {
        return;
      }
      const updatedAt = parseTs(o['updatedAt']) ?? mtime;
      out.push({
        short,
        sessionId: str(o['sessionId']) ?? str(o['resumeSessionId']),
        cwd: str(o['cwd']),
        name: str(o['name']),
        state: str(o['state']) ?? 'unknown',
        detail: str(o['detail']) ?? str(o['intent']),
        tempo: str(o['tempo']),
        updatedAt,
        live: null
      });
    })
  );
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export function isTerminalJobState(state: string): boolean {
  return state === 'done' || state === 'failed' || state === 'stopped' || state === 'killed';
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function parseTs(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}
