import type { LiveSession } from '../model/types';

/**
 * Claude Code runs an interactive conversation as two processes: the terminal UI, whose registry
 * entry is *parked* (`parkedJobId`) and whose status stops moving, and a worker registered as
 * `kind: 'bg'` with the matching `jobId`, whose status is the real one. Fold each parked UI into
 * its worker (the worker becomes the interactive session; `uiPid` remembers the terminal) and drop
 * the parked entry. A parked UI whose worker is gone is kept as-is so the conversation still shows.
 */
export function attachParked(list: LiveSession[]): LiveSession[] {
  const parked = new Map<string, LiveSession>();
  for (const l of list) if (l.kind === 'interactive' && l.parkedJobId) parked.set(l.parkedJobId, l);
  if (parked.size === 0) return list;
  const attached = new Set<LiveSession>();
  const out: LiveSession[] = [];
  for (const l of list) {
    if (l.kind === 'bg' && l.jobId && parked.has(l.jobId)) {
      const ui = parked.get(l.jobId) as LiveSession;
      attached.add(ui);
      out.push({
        ...l,
        kind: 'interactive',
        uiPid: ui.pid,
        name: l.name ?? ui.name,
        nameSource: l.name ? l.nameSource : ui.nameSource,
        formerNames: l.formerNames.length ? l.formerNames : ui.formerNames
      });
      continue;
    }
    out.push(l);
  }
  return out.filter(l => !attached.has(l));
}
