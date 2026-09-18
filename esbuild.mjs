import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');
const snapshot = process.argv.includes('--snapshot');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info'
};

/** Fails the build if the worker bundle would import 'vscode' (it runs outside the extension host). */
const noVscodePlugin = {
  name: 'no-vscode',
  setup(build) {
    build.onResolve({ filter: /^vscode$/ }, args => ({
      errors: [{ text: `'vscode' imported from ${args.importer} — the worker must stay free of VS Code APIs` }]
    }));
  }
};

const builds = [];
if (test) {
  builds.push({ ...common, entryPoints: ['scripts/test.ts'], outfile: 'dist/test.js' });
  // The worker round-trip test forks the real worker bundle.
  builds.push({ ...common, entryPoints: ['src/backend/worker-main.ts'], outfile: 'dist/worker.js', external: ['vscode'], plugins: [noVscodePlugin] });
} else if (snapshot) {
  builds.push({ ...common, entryPoints: ['scripts/snapshot.ts'], outfile: 'dist/snapshot.js' });
} else {
  builds.push({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    external: ['vscode'],
    minify: !watch
  });
  // Scanner worker: a plain Node process, so 'vscode' must not leak into it.
  builds.push({
    ...common,
    entryPoints: ['src/backend/worker-main.ts'],
    outfile: 'dist/worker.js',
    external: ['vscode'],
    minify: !watch,
    plugins: [noVscodePlugin]
  });
}

for (const opts of builds) {
  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
  } else {
    await esbuild.build(opts);
  }
}
