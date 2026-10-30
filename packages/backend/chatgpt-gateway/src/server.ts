import { once } from 'node:events';
import { chmod, mkdir, rm } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Accounts } from './accounts.ts';
import { OpenAI } from './openai.ts';
import { Responses } from './protocol.ts';
import { Store } from './store.ts';
import { fail, publicError, readJson } from './util.ts';

export async function startGateway(options: {
  statePath: string;
  keyPath: string;
  socketPath: string;
  port?: number;
  host?: string;
  upstream?: OpenAI;
}) {
  const store = await Store.load(options.statePath, options.keyPath);
  const upstream = options.upstream ?? new OpenAI();
  const responses = new Responses(upstream);
  const accounts = new Accounts(store, upstream, responses);
  let inFlight = 0;
  const handleApi = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    const abort = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    let admitted = false;
    try {
      if (req.method === 'GET' && req.url === '/health') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const key = accounts.authenticate(req.headers.authorization);
      if (req.method === 'GET' && req.url === '/v1/models') {
        const state = accounts.status();
        const configured = state.enabled && state.selected;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            object: 'list',
            data: configured
              ? [
                  {
                    id: 'chatgpt-default',
                    object: 'model',
                    created: 0,
                    owned_by: 'personal-chatgpt-gateway',
                  },
                ]
              : [],
          })
        );
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/responses')
        return fail('not_found', 'Unsupported endpoint.', 404);
      if (inFlight >= 8)
        return fail('gateway_busy', 'Too many concurrent requests.', 429);
      inFlight++;
      admitted = true;
      const body = await readJson(req);
      const session = await accounts.session(key);
      const result = await responses.run(
        body,
        session,
        abort.signal,
        body.stream === true
          ? async event => {
              if (abort.signal.aborted)
                return fail('cancelled', 'Request cancelled.', 499);
              if (!res.headersSent)
                res.setHeader('Content-Type', 'text/event-stream');
              if (!res.write('data: ' + JSON.stringify(event) + '\n\n')) {
                await once(res, 'drain', { signal: abort.signal });
              }
            }
          : undefined
      );
      if (body.stream !== true) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } else res.end();
    } catch (error) {
      const safe = publicError(error);
      if (res.destroyed) return;
      const detail = {
        code: safe.code,
        message: safe.message,
        type: 'gateway_error',
      };
      if (res.headersSent) {
        // AFFiNE's Responses adapter recognizes response.error.
        res.end(
          'data: ' +
            JSON.stringify({ type: 'response.error', error: detail }) +
            '\n\n'
        );
      } else {
        res.statusCode = safe.status;
        if (safe.retryAfter && /^\d+$/.test(safe.retryAfter))
          res.setHeader('Retry-After', safe.retryAfter);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: detail }));
      }
    } finally {
      if (admitted) inFlight--;
    }
  };
  const api = createServer((req, res) => {
    handleApi(req, res).catch(() => res.destroy());
  });
  api.requestTimeout = 30_000;
  api.headersTimeout = 10_000;
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  // Refuse to steal a live daemon socket. Container lifecycle removes stale sockets.
  const handleControl = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Content-Type', 'application/json');
    try {
      if (req.method !== 'POST' || req.url !== '/command')
        return fail('not_found', 'Unknown control endpoint.', 404);
      const command = await readJson(req, 128 * 1024);
      const result = await accounts.command(command);
      res.end(JSON.stringify({ result }));
    } catch (error) {
      const safe = publicError(error);
      res.statusCode = safe.status;
      res.end(
        JSON.stringify({ error: { code: safe.code, message: safe.message } })
      );
    }
  };
  const control = createServer((req, res) => {
    handleControl(req, res).catch(() => res.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    control.once('error', reject);
    control.listen(options.socketPath, resolve);
  });
  await chmod(options.socketPath, 0o600);
  await new Promise<void>((resolve, reject) => {
    api.once('error', reject);
    api.listen(options.port ?? 8080, options.host ?? '0.0.0.0', resolve);
  });
  return {
    api,
    control,
    accounts,
    responses,
    close: async () => {
      api.closeAllConnections();
      control.closeAllConnections();
      await Promise.all([
        new Promise<void>(resolve => api.close(() => resolve())),
        new Promise<void>(resolve => control.close(() => resolve())),
      ]);
      await rm(options.socketPath, { force: true });
    },
  };
}

async function main() {
  const socketPath =
    process.env.GATEWAY_CONTROL_SOCKET ?? '/run/gateway/control.sock';
  // /run/gateway is a per-container tmpfs; never shared with another process/container.
  await rm(socketPath, { force: true });
  const gateway = await startGateway({
    socketPath,
    statePath: process.env.GATEWAY_STATE ?? '/data/state.enc',
    keyPath: process.env.GATEWAY_KEY_FILE ?? '/keys/master.key',
    port: Number(process.env.PORT ?? 8080),
  });
  console.log('AI extension ready.');
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      gateway
        .close()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    console.error(
      'AI extension could not start. Check its state volume, encryption key, and socket.'
    );
    process.exitCode = 1;
  });
}
