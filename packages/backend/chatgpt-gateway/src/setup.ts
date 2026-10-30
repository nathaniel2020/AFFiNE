import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Json } from './types.ts';
import { atomicWrite } from './util.ts';

const fields =
  'profileId provider name description enabled revision definition { endpoint { kind url dialect } models { modelId enabled capabilities { input output features attachmentKinds attachmentSources } } }';
const settingsQuery =
  'query($id:String!){currentUser{id} workspace(id:$id){id team memberCount owner{id} byokSettings{serverEntitled profiles{' +
  fields +
  '}}} appConfig}';
const managedKeys = [
  'enabled',
  'byok.enabled',
  'byok.allowedProviders',
  'byok.allowCustomEndpoint',
  'byok.allowPrivateEndpoint',
  'chatgptEnabled',
];
function get(object: Json, path: string): any {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

export function textCandidates(profiles: Json[]) {
  return profiles.filter(
    p =>
      p.enabled &&
      p.definition.models.some(
        (model: Json) =>
          model.enabled &&
          model.capabilities.some(
            (cap: Json) =>
              cap.input.includes('text') &&
              cap.output.some((out: string) =>
                ['text', 'object', 'structured'].includes(out)
              )
          )
      )
  );
}
export function gatewayReady(status: Json) {
  const selected = status.selected;
  const profile = status.profiles.find(
    (p: Json) => p.id === selected?.profileId
  );
  return !!(
    status.enabled &&
    selected &&
    profile?.status === 'connected' &&
    profile.models.some((model: Json) => model.slug === selected.model) &&
    ['text', 'structured', 'tools'].every(capability =>
      profile.verified[selected.model]?.includes(capability)
    )
  );
}
export const gatewayDefinition = {
  endpoint: {
    kind: 'openai_compatible',
    url: 'http://affine-ai-extension:8080/v1',
    dialect: 'responses',
  },
  models: [
    {
      modelId: 'chatgpt-default',
      enabled: true,
      capabilities: [
        {
          input: ['text'],
          output: ['text'],
          features: ['tool_calling'],
          attachmentKinds: [],
          attachmentSources: [],
        },
        {
          input: ['text'],
          output: ['object', 'structured'],
          features: [],
          attachmentKinds: [],
          attachmentSources: [],
        },
      ],
    },
  ],
};

export async function configureAffine(options: {
  server: string;
  workspace?: string;
  credentialsFile: string;
  backupDirectory: string;
  gatewayKey?: string;
  gatewayReady: boolean;
  rollbackFile?: string;
}) {
  const origin = new URL(options.server);
  if (
    origin.username ||
    origin.password ||
    (origin.protocol !== 'https:' &&
      !(
        origin.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
      ))
  ) {
    throw new Error('Use HTTPS or a loopback HTTP AFFiNE endpoint.');
  }
  const info = await stat(options.credentialsFile);
  if (info.mode & 0o077)
    throw new Error('Credentials file must have mode 0600.');
  const credential = JSON.parse(
    await readFile(options.credentialsFile, 'utf8')
  );
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-affine-client-kind': 'native',
    'x-affine-version': '0.27.5',
  };
  let refreshToken: string | undefined;
  const request = async (path: string, body?: Json) => {
    const response = await fetch(new URL(path, origin.origin), {
      method: body ? 'POST' : 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok)
      throw new Error(
        'AFFiNE request failed (HTTP ' +
          response.status +
          ', ' +
          path +
          '). Check account, permissions and server configuration.'
      );
    return (await response.json()) as Json;
  };
  const gql = async (query: string, variables: Json = {}) => {
    const result = await request('/graphql', { query, variables });
    if (result.errors?.length)
      throw new Error(
        'AFFiNE rejected configuration: ' +
          result.errors.map((e: Json) => e.message).join('; ')
      );
    return result.data as Json;
  };
  if (credential.accessToken)
    headers.Authorization = 'Bearer ' + credential.accessToken;
  else {
    const signed = await request('/api/auth/sign-in', {
      email: credential.email,
      password: credential.password,
    });
    delete credential.password;
    if (!signed.exchangeCode)
      throw new Error(
        'Native authentication is unavailable. Use an existing admin account with a password.'
      );
    const exchanged = await request('/api/auth/session/exchange', {
      code: signed.exchangeCode,
      installationId: randomUUID(),
      platform: 'electron',
      deviceName: 'AI extension setup',
    });
    headers.Authorization = 'Bearer ' + exchanged.accessToken;
    refreshToken = exchanged.refreshToken;
  }
  try {
    const update = (updates: Json[]) =>
      gql(
        'mutation($updates:[UpdateAppConfigInput!]!){updateAppConfig(updates:$updates)}',
        { updates }
      );
    if (options.rollbackFile) {
      const backup = JSON.parse(await readFile(options.rollbackFile, 'utf8'));
      if (backup.server !== origin.origin)
        throw new Error('Backup belongs to a different server.');
      if (backup.gatewayProfileId)
        await gql(
          'mutation($workspaceId:String!,$profileId:ID!){deleteWorkspaceByokProfile(workspaceId:$workspaceId,profileId:$profileId)}',
          { workspaceId: backup.workspace, profileId: backup.gatewayProfileId }
        );
      await update(backup.updates);
      if (backup.chatgpt?.active && backup.chatgpt.defaultModel) {
        await request('/api/copilot/chatgpt', {
          action: 'select',
          profileId: backup.chatgpt.id,
          model: backup.chatgpt.defaultModel,
        });
      }
      console.log(
        'Original AI routing settings restored. Reopen Canary AI and refresh its model selection.'
      );
      return;
    }
    if (!options.gatewayReady)
      throw new Error(
        'Authorize, verify and select a gateway model before configuring AFFiNE.'
      );
    const data = await gql(settingsQuery, { id: options.workspace });
    const workspace = data.workspace;
    if (
      workspace.team ||
      workspace.memberCount !== 1 ||
      workspace.owner.id !== data.currentUser.id
    ) {
      throw new Error(
        'The personal AI extension requires a single-member workspace owned by this account.'
      );
    }
    if (!workspace.byokSettings.serverEntitled)
      throw new Error('This workspace does not have server BYOK access.');
    if (textCandidates(workspace.byokSettings.profiles).length) {
      throw new Error(
        'An existing text/structured BYOK provider could become a fallback. Disable its text models explicitly before setup; other providers were not changed.'
      );
    }
    if (
      (data.appConfig.copilot?.providers?.profiles ?? []).some(
        (p: Json) => p.enabled !== false
      )
    ) {
      throw new Error(
        'Managed server providers are configured. Resolve text-provider fallback routing before personal extension setup.'
      );
    }
    const oldChatgpt = await request('/api/copilot/chatgpt').catch(() => ({
      profiles: [],
    }));
    const backup: Json = {
      server: origin.origin,
      workspace: options.workspace,
      updates: managedKeys.map(key => ({
        module: 'copilot',
        key,
        ...(get(data.appConfig.copilot, key) === undefined
          ? { clear: true }
          : { value: get(data.appConfig.copilot, key) }),
      })),
      chatgpt: oldChatgpt.profiles?.find((p: Json) => p.active),
    };
    const backupPath = join(
      options.backupDirectory,
      'affine-backup-' + Date.now() + '.json'
    );
    await atomicWrite(backupPath, JSON.stringify(backup, null, 2));
    try {
      if (backup.chatgpt)
        await request('/api/copilot/chatgpt', {
          action: 'disable',
          profileId: backup.chatgpt.id,
        });
      await update([
        { module: 'copilot', key: 'enabled', value: true },
        { module: 'copilot', key: 'byok.enabled', value: true },
        {
          module: 'copilot',
          key: 'byok.allowedProviders',
          value: [
            ...new Set([
              ...(data.appConfig.copilot?.byok?.allowedProviders ?? []),
              'openai',
            ]),
          ],
        },
        { module: 'copilot', key: 'byok.allowCustomEndpoint', value: true },
        { module: 'copilot', key: 'byok.allowPrivateEndpoint', value: true },
        { module: 'copilot', key: 'chatgptEnabled', value: false },
      ]);
      const created = await gql(
        'mutation($input:CreateWorkspaceByokProfileInput!){createWorkspaceByokProfile(input:$input){profileId}}',
        {
          input: {
            workspaceId: options.workspace,
            provider: 'openai',
            name: 'AI 集成（Beta）',
            description:
              'Independent personal ChatGPT gateway. Keep as the only text/structured candidate.',
            credential: options.gatewayKey,
            definition: gatewayDefinition,
            enabled: true,
          },
        }
      );
      backup.gatewayProfileId = created.createWorkspaceByokProfile.profileId;
      await atomicWrite(backupPath, JSON.stringify(backup, null, 2));
      const probe = await gql(
        'mutation($input:ProbeWorkspaceByokProfileInput!){probeWorkspaceByokProfile(input:$input){stale connection{kind errorKind} models{checks{operation status{kind errorKind}}}}}',
        {
          input: {
            workspaceId: options.workspace,
            profileId: backup.gatewayProfileId,
            checks: ['chat', 'structured', 'tool_calling'].map(operation => ({
              modelId: 'chatgpt-default',
              operation,
            })),
          },
        }
      );
      const result = probe.probeWorkspaceByokProfile;
      if (
        result.stale ||
        result.connection.kind !== 'verified' ||
        result.models.some((m: Json) =>
          m.checks.some((c: Json) => c.status.kind !== 'verified')
        )
      ) {
        const failures = result.models.flatMap((m: Json) =>
          m.checks
            .filter((c: Json) => c.status.kind !== 'verified')
            .map(
              (c: Json) =>
                c.operation +
                ': ' +
                c.status.kind +
                ' (' +
                (c.status.errorKind ?? 'unknown') +
                ')'
            )
        );
        throw new Error(
          'AFFiNE capability probes did not all pass: ' + failures.join('; ')
        );
      }
    } catch (error) {
      console.error(
        'Setup did not complete. Restore with the rollback command and this backup: ' +
          backupPath
      );
      throw error;
    }
    console.log('Configured personal workspace. Backup: ' + backupPath);
    console.log(
      'Reopen AI in official AFFiNE-canary and choose Auto. Do not add competing text providers or local keys.'
    );
  } finally {
    if (refreshToken)
      await request('/api/auth/session/revoke', { refreshToken }).catch(
        () => {}
      );
  }
}
