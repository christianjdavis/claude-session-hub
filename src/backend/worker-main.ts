// Entry point of the scanner worker process (dist/worker.js). Must never import 'vscode'.
import { BACKEND_METHODS } from './api';
import type { PushMessage, RpcRequest, RpcResponse } from './api';
import { LocalBackend } from './local';

const backend = new LocalBackend();
const methods = new Set<string>(BACKEND_METHODS);

function send(msg: RpcResponse | PushMessage): void {
  if (process.send) process.send(msg);
}

backend.onPush(msg => send(msg));

process.on('message', (req: RpcRequest) => {
  if (!req || typeof req !== 'object' || !methods.has(req.method)) return;
  const fn = (backend as unknown as Record<string, (...a: unknown[]) => unknown>)[req.method];
  if (typeof fn !== 'function') return;
  const t0 = performance.now();
  Promise.resolve()
    .then(() => fn.apply(backend, req.args))
    .then(
      result => {
        if (!req.oneWay) send({ id: req.id, ok: true, result, ms: Math.round(performance.now() - t0) });
      },
      err => {
        if (!req.oneWay) send({ id: req.id, ok: false, error: (err as Error)?.stack ?? String(err), ms: Math.round(performance.now() - t0) });
      }
    );
});

// The extension host went away (reload, disable, crash): do not linger.
process.on('disconnect', () => process.exit(0));
process.on('uncaughtException', err => {
  process.stderr.write(`worker uncaught: ${err.stack ?? err}\n`);
});
process.on('unhandledRejection', err => {
  process.stderr.write(`worker unhandled: ${(err as Error)?.stack ?? String(err)}\n`);
});

if (process.send) process.send({ id: 0, ok: true, result: { ready: true, pid: process.pid } } satisfies RpcResponse);
