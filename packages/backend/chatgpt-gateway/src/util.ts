import { createHash, randomBytes } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';

export class GatewayError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public retryAfter?: string
  ) {
    super(message);
  }
}
export const fail = (code: string, message: string, status = 400): never => {
  throw new GatewayError(code, message, status);
};
export function publicError(error: unknown) {
  return error instanceof GatewayError
    ? error
    : new GatewayError(
        'gateway_unavailable',
        'Operation failed; check the gateway connection and try again.',
        502
      );
}
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export async function atomicWrite(path: string, bytes: string | Buffer) {
  const temporary = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function readJson(stream: Readable, limit = 8 * 1024 * 1024) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit)
      fail('request_too_large', 'Request exceeds the size limit.', 413);
    chunks.push(bytes);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    return value as Record<string, any>;
  } catch {
    return fail('invalid_json', 'Expected a JSON object.');
  } finally {
    chunks.forEach(chunk => chunk.fill(0));
  }
}
