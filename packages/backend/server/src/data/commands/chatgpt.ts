import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Injectable } from '@nestjs/common';

import { BackendRuntimeProvider } from '../../core/backend-runtime';

@Injectable()
export class ChatgptCommand {
  constructor(private readonly backend: BackendRuntimeProvider) {}

  async execute(
    action: string,
    options: {
      userId: string;
      profileId?: string;
      model?: string;
      hostIdFile?: string;
    }
  ) {
    if (
      ![
        'status',
        'import',
        'refreshModels',
        'select',
        'disable',
        'disconnect',
      ].includes(action)
    ) {
      throw new Error('Unknown ChatGPT command');
    }
    // One stable VM identity, independent of any imported laptop registration.
    const path =
      options.hostIdFile ?? join(CUSTOM_CONFIG_PATH, 'chatgpt-host-id');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, `urn:uuid:${randomUUID()}`, {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const hostId = (await readFile(path, 'utf8')).trim();
    if (!/^urn:uuid:[a-f\d-]{36}$/i.test(hostId))
      throw new Error('Invalid persisted ChatGPT host ID');
    const command: Record<string, unknown> = {
      action,
      profileId: options.profileId,
      model: options.model,
    };
    if (action === 'import') {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > 64 * 1024)
          throw new Error('ChatGPT import record is too large');
        chunks.push(buffer);
      }
      const buffer = Buffer.concat(chunks);
      try {
        command.record = JSON.parse(buffer.toString());
      } catch {
        throw new Error('Invalid ChatGPT import record');
      } finally {
        buffer.fill(0);
        chunks.forEach(chunk => chunk.fill(0));
      }
    }
    const result = await this.backend.chatgptCommand(options.userId, command);
    process.stdout.write(
      `AFFINE_CHATGPT_RESULT:${JSON.stringify({ result, hostId })}\n`
    );
  }
}
