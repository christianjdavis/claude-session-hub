import * as path from 'node:path';

export interface UploadTarget {
  src: string;
  dst: string;
}

/** Where each source lands when copied into `dir`: same base name, no renaming. Pure, so it is testable without VS Code. */
export function uploadTargets(sources: string[], dir: string): UploadTarget[] {
  const seen = new Set<string>();
  const out: UploadTarget[] = [];
  for (const src of sources) {
    const dst = path.join(dir, path.basename(src));
    if (seen.has(dst)) continue;
    seen.add(dst);
    out.push({ src, dst });
  }
  return out;
}
