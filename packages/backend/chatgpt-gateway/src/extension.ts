#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { signIn } from './oauth.mjs';
import { configureAffine } from './setup.ts';
import type { Json } from './types.ts';
import { atomicWrite } from './util.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    network: { type: 'string' },
    image: { type: 'string' },
    container: { type: 'string' },
    'state-dir': { type: 'string' },
    profile: { type: 'string' },
    model: { type: 'string' },
    'client-id': { type: 'string' },
    consent: { type: 'boolean' },
    rotate: { type: 'boolean' },
    'purge-data': { type: 'boolean' },
    server: { type: 'string' },
    workspace: { type: 'string' },
    'credentials-file': { type: 'string' },
    rollback: { type: 'string' },
    help: { type: 'boolean' },
  },
});
type Config = {
  network?: string;
  image: string;
  container: string;
  hostId: string;
  pending?: { clientId: string };
};
const directory =
  values['state-dir'] ?? join(homedir(), '.config', 'affine-ai-extension');
const configFile = join(directory, 'config.json');
const compose = join(dirname(fileURLToPath(import.meta.url)), 'compose.yml');

async function execute(
  program: string,
  args: string[],
  input?: string,
  env = process.env
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      shell: false,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 300_000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 4 * 1024 * 1024) child.kill();
    });
    child.stderr.resume(); // Never echo credential records from subprocess diagnostics.
    child.stdin.on('error', () => {});
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else
        reject(
          new Error(
            program +
              ' failed (' +
              code +
              '). Check Docker availability and the selected extension container.'
          )
        );
    });
    child.stdin.end(input);
  });
}

async function main() {
  const action = positionals[0] ?? 'help';
  if (values.help || action === 'help') {
    console.log(
      [
        'AI integration background extension',
        'install --network DOCKER_NETWORK [--image IMAGE]',
        'login [--profile ID] [--consent] [--client-id ISSUED_ID]',
        'status | models --profile ID | verify --profile ID --model SLUG',
        'select --profile ID --model SLUG | disconnect --profile ID',
        'configure --server URL --workspace ID --credentials-file FILE',
        'rollback --server URL --credentials-file FILE --rollback BACKUP_FILE',
        'key [--rotate] | enable | disable | stop | start | update [--image IMAGE]',
        'uninstall [--purge-data]',
        'All commands accept --state-dir DIR. configure requires an existing admin/owner account.',
        'Credentials file: mode 0600 JSON containing email and password; never stored by the extension.',
        'Only the explicit key command prints the extension access key. Never share that output.',
      ].join('\n')
    );
    return;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let config: Config = {
    image: 'affine-chatgpt-gateway:local',
    container: 'affine_ai_extension',
    hostId: 'urn:uuid:' + randomUUID(),
  };
  try {
    config = { ...config, ...JSON.parse(await readFile(configFile, 'utf8')) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  config.network = values.network ?? config.network;
  config.image = values.image ?? config.image;
  config.container = values.container ?? config.container;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(config.container))
    throw new Error('Invalid container name.');
  await atomicWrite(configFile, JSON.stringify(config));
  const command = async (body: Json) => {
    const output = await execute(
      'docker',
      ['exec', '-i', config.container, 'node', '/app/control.mjs'],
      JSON.stringify(body)
    );
    const response = JSON.parse(output);
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  if (['install', 'start', 'stop', 'update', 'uninstall'].includes(action)) {
    if (!config.network)
      throw new Error(
        'Specify the existing AFFiNE Docker network with --network.'
      );
    await execute('docker', ['network', 'inspect', config.network]);
    const args = ['compose', '-p', 'affine-ai-extension', '-f', compose];
    if (action === 'stop') args.push('stop');
    else if (action === 'uninstall')
      args.push('down', ...(values['purge-data'] ? ['--volumes'] : []));
    else
      args.push(
        'up',
        '-d',
        '--wait',
        ...(action === 'update' ? ['--force-recreate'] : [])
      );
    await execute('docker', args, undefined, {
      ...process.env,
      AFFINE_NETWORK: config.network,
      GATEWAY_IMAGE: config.image,
      GATEWAY_CONTAINER: config.container,
    });
    console.log(
      action === 'uninstall'
        ? values['purge-data']
          ? 'Extension removed, including its own data volumes.'
          : 'Extension removed. Its account and key volumes were retained.'
        : 'Extension ' + action + ' completed.'
    );
    return;
  }
  if (action === 'login') {
    const status = await command({ action: 'status' });
    const requested = values.profile;
    const registration = requested
      ? status.profiles.find((p: Json) => p.id === requested)
      : status.profiles.find((p: Json) => p.clientId === values['client-id']);
    if (requested && !registration) throw new Error('Unknown profile.');
    if (
      values['client-id'] &&
      !/^oaiapp_[A-Za-z0-9_-]{1,240}$/.test(values['client-id'])
    )
      throw new Error('Invalid recovery client ID.');
    const cancellation = new AbortController();
    process.once('SIGINT', () => cancellation.abort());
    const record = await signIn({
      hostId: config.hostId,
      registration:
        registration ??
        (values['client-id']
          ? { clientId: values['client-id'] }
          : config.pending),
      consent: values.consent,
      signal: cancellation.signal,
      rememberClient: async (clientId: string) => {
        config.pending = { clientId };
        await atomicWrite(configFile, JSON.stringify(config));
      },
      openBrowser: async (url: string) => {
        console.log(
          'Complete ChatGPT authorization in your browser. This helper waits up to 15 minutes.'
        );
        await execute(
          process.platform === 'darwin'
            ? 'open'
            : process.platform === 'win32'
              ? 'explorer.exe'
              : 'xdg-open',
          [url]
        );
      },
    });
    try {
      const imported = await command({ action: 'import', record });
      delete config.pending;
      await atomicWrite(configFile, JSON.stringify(config));
      console.log('Connected profile: ' + imported.id);
      if (imported.status === 'connected')
        console.log(
          JSON.stringify(
            await command({ action: 'models', profileId: imported.id }),
            null,
            2
          )
        );
      else
        console.log(
          'Plan permission is required. Reconnect this profile with --consent.'
        );
    } finally {
      record.access_token = '';
      record.refresh_token = '';
      record.id_token = '';
    }
    return;
  }
  if (action === 'configure' || action === 'rollback') {
    if (
      !values.server ||
      !values['credentials-file'] ||
      (action === 'configure' && !values.workspace)
    )
      throw new Error('Specify --server, --credentials-file and --workspace.');
    await configureAffine({
      server: values.server,
      workspace: values.workspace,
      credentialsFile: values['credentials-file'],
      backupDirectory: directory,
      rollbackFile: action === 'rollback' ? values.rollback : undefined,
      gatewayKey:
        action === 'configure'
          ? (await command({ action: 'key' })).key
          : undefined,
      gatewayReady:
        action === 'configure'
          ? !!(await command({ action: 'status' })).selected
          : false,
    });
    return;
  }
  const result = await command({
    action,
    profileId: values.profile,
    model: values.model,
    rotate: values.rotate,
  });
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => {
  console.error(
    error instanceof Error ? error.message : 'Extension command failed.'
  );
  process.exitCode = 1;
});
