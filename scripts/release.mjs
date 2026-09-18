// Bump the version, make sure CHANGELOG.md has a section for it, commit, tag, push.
// Usage: npm run release -- patch|minor|major|x.y.z
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
const kind = process.argv[2];
if (!kind) {
  console.error('usage: npm run release -- patch|minor|major|x.y.z');
  process.exit(2);
}
if (sh('git status --porcelain')) {
  console.error('working tree is not clean; commit or stash first');
  process.exit(1);
}
if (sh('git rev-parse --abbrev-ref HEAD') !== 'main') {
  console.error('release from main');
  process.exit(1);
}
const next = sh(`npm version ${kind} --no-git-tag-version`).replace(/^v/, '');
const changelog = readFileSync('CHANGELOG.md', 'utf8');
if (!changelog.includes(`## [${next}]`)) {
  sh('git checkout -- package.json package-lock.json');
  console.error(`CHANGELOG.md has no "## [${next}]" section; add one, then run again`);
  process.exit(1);
}
sh('git add package.json package-lock.json');
sh(`git commit -q -m "v${next}"`);
sh(`git tag -a v${next} -m "v${next}"`);
// Branch first, then the tag: the tag push is what starts the release workflow.
sh('git push -q origin main');
sh(`git push -q origin v${next}`);
console.log(`released v${next}: https://github.com/christianjdavis/claude-session-hub/actions`);
