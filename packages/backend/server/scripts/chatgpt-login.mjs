#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { AUTHORIZATION_TIMEOUT_MS, signIn } from './chatgpt/oauth.mjs';

const { values } = parseArgs({
  options: {
    'user-id': { type: 'string' },
    container: { type: 'string', default: 'affine_server' },
    'profile-id': { type: 'string' },
    'client-id': { type: 'string' },
    consent: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help || !values['user-id']) {
  console.log(
    'Usage: node packages/backend/server/scripts/chatgpt-login.mjs --user-id <AFFiNE-user-id> [--container affine_server] [--profile-id <id>] [--client-id <issued-id-for-recovery>] [--consent]'
  );
  process.exit(values.help ? 0 : 1);
}

function execute(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 1024 * 1024) child.kill();
    });
    // CLI diagnostics must never echo a credential record.
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', code =>
      code === 0
        ? resolve(output)
        : reject(
            new Error(
              `${command} failed (${code}); inspect server status without printing credentials`
            )
          )
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function containerCommand(action, record) {
  const output = await execute(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'SERVER_FLAVOR=script',
      values.container,
      'node',
      './dist/main.js',
      'chatgpt',
      action,
      '--user-id',
      values['user-id'],
    ],
    record && JSON.stringify(record)
  );
  const line = output
    .split('\n')
    .findLast(line => line.startsWith('AFFINE_CHATGPT_RESULT:'));
  if (!line)
    throw new Error(
      'Server does not provide the ChatGPT CLI; install the feature image first'
    );
  return JSON.parse(line.slice('AFFINE_CHATGPT_RESULT:'.length));
}

try {
  const recoveredClientId = values['client-id'];
  if (
    recoveredClientId &&
    (!/^oaiapp_[A-Za-z0-9_-]+$/.test(recoveredClientId) ||
      recoveredClientId.length > 256)
  ) {
    throw new Error('Recovery requires an issued OpenAI client ID');
  }
  const { result: status } = await containerCommand('status');
  if (!status.enabled)
    throw new Error(
      'Enable copilot.chatgptEnabled in the self-hosted server configuration first'
    );
  const registration = values['profile-id']
    ? status.profiles.find(p => p.id === values['profile-id'])
    : status.profiles.find(p => p.clientId === recoveredClientId);
  if (values['profile-id'] && !registration)
    throw new Error('Selected connection not found for this AFFiNE user');
  if (
    registration &&
    recoveredClientId &&
    registration.clientId !== recoveredClientId
  )
    throw new Error(
      'Recovery client ID does not match the selected connection'
    );
  const directory = join(homedir(), '.config/affine-chatgpt');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const hostPath = join(directory, 'host-id');
  try {
    await writeFile(hostPath, `urn:uuid:${randomUUID()}`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const hostId = (await readFile(hostPath, 'utf8')).trim();
  if (!/^urn:uuid:[a-f\d-]{36}$/i.test(hostId))
    throw new Error('Invalid persisted helper host ID');
  const pendingPath = join(
    directory,
    `${createHash('sha256')
      .update(
        `${process.env.DOCKER_CONTEXT ?? process.env.DOCKER_HOST ?? 'default'}:${values.container}:${values['user-id']}`
      )
      .digest('hex')}.json`
  );
  let pending;
  try {
    pending = JSON.parse(await readFile(pendingPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Public registration metadata only. No token is persisted on this computer.
  const saved =
    registration ??
    (recoveredClientId
      ? { clientId: recoveredClientId }
      : pending && !status.profiles.some(p => p.clientId === pending.clientId)
        ? pending
        : undefined);
  const rememberClient = async clientId => {
    const temporary = `${pendingPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ clientId }), {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, pendingPath);
  };
  // Recover only the public registration identifier, never an old code or token.
  if (recoveredClientId && !registration)
    await rememberClient(recoveredClientId);
  const cancellation = new AbortController();
  process.once('SIGINT', () => cancellation.abort());
  const record = await signIn({
    hostId,
    registration: saved,
    consent: values.consent,
    signal: cancellation.signal,
    rememberClient,
    openBrowser: async url => {
      console.log('Opening the official ChatGPT sign-in page.');
      const command =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'explorer.exe'
            : 'xdg-open';
      await execute(command, [url]);
      console.log(
        `Waiting up to ${AUTHORIZATION_TIMEOUT_MS / 60_000} minutes for authorization. Keep this helper running until import completes.`
      );
    },
  });
  try {
    const { result } = await containerCommand('import', record);
    console.log(
      `ChatGPT connection imported (${result.id}). Open AFFiNE Web settings, refresh models and select the default model.`
    );
    console.log(
      'The Docker server now owns token renewal. No credentials were saved on this computer.'
    );
  } finally {
    record.access_token = '';
    record.refresh_token = '';
    record.id_token = '';
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
