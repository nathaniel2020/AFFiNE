import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { State } from './types.ts';
import { atomicWrite } from './util.ts';

// One daemon owns the file; management clients communicate over its Unix socket.
// Encrypt the entire state, including identity/model metadata and gateway access key.
export class Store {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(
    private readonly path: string,
    private readonly key: Buffer,
    private state: State
  ) {}

  static async load(path: string, keyPath: string) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
    let encoded: Buffer | undefined;
    try {
      encoded = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // A lost key must never be silently replaced for an existing state.
    if (!encoded) {
      try {
        await writeFile(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const key = await readFile(keyPath);
    if (key.length !== 32) throw new Error('Invalid gateway encryption key');
    let state: State = {
      version: 1,
      hostId: 'urn:uuid:' + randomUUID(),
      enabled: true,
      profiles: [],
    };
    if (encoded) {
      const envelope = JSON.parse(encoded.toString());
      if (envelope.version !== 1)
        throw new Error('Unsupported gateway state version');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(envelope.nonce, 'base64')
      );
      decipher.setAAD(Buffer.from('AFFiNE/ChatGPT-Gateway/state/v1'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, 'base64')),
        decipher.final(),
      ]);
      try {
        state = JSON.parse(plaintext.toString());
      } finally {
        plaintext.fill(0);
      }
      if (state.version !== 1 || !Array.isArray(state.profiles))
        throw new Error('Invalid gateway state');
    }
    const store = new Store(path, key, state);
    if (!encoded) await store.update(() => {});
    return store;
  }

  snapshot(): State {
    return structuredClone(this.state);
  }

  async update<T>(mutate: (draft: State) => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      const draft = this.snapshot();
      const result = await mutate(draft);
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
      cipher.setAAD(Buffer.from('AFFiNE/ChatGPT-Gateway/state/v1'));
      const plaintext = Buffer.from(JSON.stringify(draft));
      let encrypted: Buffer;
      try {
        encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      } finally {
        plaintext.fill(0);
      }
      await atomicWrite(
        this.path,
        JSON.stringify({
          version: 1,
          nonce: nonce.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          data: encrypted.toString('base64'),
        })
      );
      this.state = draft;
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
