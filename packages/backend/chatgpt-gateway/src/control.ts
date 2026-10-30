import { request } from 'node:http';
import { pathToFileURL } from 'node:url';

import type { Json } from './types.ts';
import { GatewayError, publicError, readJson } from './util.ts';

export async function control(
  command: Json,
  socketPath = process.env.GATEWAY_CONTROL_SOCKET ?? '/run/gateway/control.sock'
): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: '/command',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 180_000,
      },
      res => {
        readJson(res)
          .then(body => {
            if (body.error)
              reject(
                new GatewayError(
                  body.error.code,
                  body.error.message,
                  res.statusCode
                )
              );
            else resolve(body.result);
          })
          .catch(reject);
      }
    );
    req.once('timeout', () =>
      req.destroy(new Error('Management operation timed out.'))
    );
    req.once('error', reject);
    req.end(JSON.stringify(command));
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  readJson(process.stdin, 128 * 1024)
    .then(command => control(command))
    .then(result => process.stdout.write(JSON.stringify({ result }) + '\n'))
    .catch(error => {
      const safe = publicError(error);
      process.stdout.write(
        JSON.stringify({ error: { code: safe.code, message: safe.message } }) +
          '\n'
      );
    });
}
