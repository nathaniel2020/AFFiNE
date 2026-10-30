import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { OpenAI, PLAN_SCOPE } from './openai.ts';
import { Responses } from './protocol.ts';
import { Store } from './store.ts';
import type { Json, Profile, Session, State } from './types.ts';
import { digest, fail, GatewayError } from './util.ts';

function profile(state: State, id: string): Profile {
  return (
    state.profiles.find(p => p.id === id) ??
    fail('unknown_profile', 'ChatGPT account not found.')
  );
}
const lifetime = (value: unknown): number => {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1 ||
    Number(value) > 86400
  )
    return fail('invalid_lifetime', 'Invalid token lifetime.');
  return Number(value);
};

export class Accounts {
  constructor(
    readonly store: Store,
    private readonly upstream: OpenAI,
    private readonly responses: Responses
  ) {}
  status() {
    const state = this.store.snapshot();
    return {
      enabled: state.enabled,
      hostId: state.hostId,
      selected: state.selected,
      keyConfigured: !!state.accessKey,
      profiles: state.profiles.map(({ tokens: _tokens, ...p }) => p),
    };
  }
  authenticate(value: string | undefined) {
    const key = this.store.snapshot().accessKey;
    if (!key || !value?.startsWith('Bearer '))
      return fail('unauthorized', 'Gateway access key required.', 401);
    const received = Buffer.from(digest(value.slice(7)));
    if (!timingSafeEqual(received, Buffer.from(digest(key))))
      return fail('unauthorized', 'Invalid gateway access key.', 401);
    return digest(key);
  }
  async import(record: Json) {
    for (const name of [
      'client_id',
      'access_token',
      'refresh_token',
      'id_token',
      'nonce',
      'scope',
      'saved_at',
    ]) {
      if (typeof record[name] !== 'string' || !record[name])
        return fail('invalid_import', 'Incomplete authorization record.');
    }
    if (
      record.client_id === 'dynamic_agent_client' ||
      !Number.isSafeInteger(record.expected_generation)
    )
      return fail('invalid_import', 'Invalid registration metadata.');
    const expires =
      Date.parse(record.saved_at) + lifetime(record.expires_in) * 1000;
    if (
      !Number.isFinite(expires) ||
      Date.parse(record.saved_at) > Date.now() + 60_000 ||
      expires <= Date.now()
    )
      return fail('expired_import', 'Authorization record expired.');
    const identity = await this.upstream.identity(
      record.id_token,
      record.client_id,
      record.nonce
    );
    const result = await this.store.update(state => {
      const old = state.profiles.find(p => p.clientId === record.client_id);
      if ((old?.generation ?? -1) !== record.expected_generation)
        return fail(
          'stale_import',
          'Connection changed; start a new authorization.'
        );
      if (
        old &&
        (old.issuer !== identity.issuer || old.subject !== identity.subject)
      )
        return fail('identity_changed', 'Returning ChatGPT identity changed.');
      const scopes = record.scope.split(/\s+/);
      const next: Profile = {
        id: old?.id ?? randomUUID(),
        clientId: record.client_id,
        ...identity,
        generation: record.expected_generation + 1,
        epoch: randomUUID(),
        expiresAt: expires,
        scopes,
        status: scopes.includes(PLAN_SCOPE) ? 'connected' : 'consent_required',
        tokens: {
          access: record.access_token,
          refresh: record.refresh_token,
          identity: record.id_token,
        },
        models: [],
        verified: {},
      };
      state.profiles = [...state.profiles.filter(p => p.id !== next.id), next];
      return { id: next.id, status: next.status };
    });
    this.responses.continuations.clear();
    return result;
  }
  async token(id: string) {
    const result = await this.store.update(async state => {
      const p = profile(state, id);
      if (p.status !== 'connected' || !p.tokens)
        return {
          error: new GatewayError(
            'reauth_required',
            'Reconnect ChatGPT or grant plan permission.',
            401
          ),
        };
      if (p.expiresAt <= Date.now() + 60_000) {
        let body: Json;
        try {
          body = await this.upstream.refresh(p);
        } catch (error) {
          if (
            error instanceof GatewayError &&
            error.code === 'reauth_required'
          ) {
            delete p.tokens;
            p.status = 'reauth_required';
            p.epoch = randomUUID();
            p.generation++;
            return { error };
          }
          throw error;
        }
        if (typeof body.access_token !== 'string' || !body.access_token)
          return fail(
            'invalid_refresh',
            'Missing refreshed access token.',
            502
          );
        if (body.id_token) {
          const identity = await this.upstream.identity(
            body.id_token,
            p.clientId
          );
          if (identity.subject !== p.subject || identity.issuer !== p.issuer)
            return fail(
              'identity_changed',
              'Refreshed ChatGPT identity changed.',
              401
            );
          p.tokens.identity = body.id_token;
        }
        p.expiresAt = Date.now() + lifetime(body.expires_in) * 1000;
        p.tokens.access = body.access_token;
        if (typeof body.refresh_token === 'string' && body.refresh_token)
          p.tokens.refresh = body.refresh_token;
        if (typeof body.scope === 'string') p.scopes = body.scope.split(/\s+/);
        p.generation++;
        if (!p.scopes.includes(PLAN_SCOPE)) {
          p.status = 'consent_required';
          return {
            error: new GatewayError(
              'consent_required',
              'ChatGPT plan permission is required.',
              401
            ),
          };
        }
      }
      return {
        token: p.tokens.access,
        epoch: p.epoch,
        generation: p.generation,
      };
    });
    if (result.error) throw result.error;
    return result as { token: string; epoch: string; generation: number };
  }
  async refreshModels(id: string) {
    const token = await this.token(id);
    const models = await this.upstream.models(token.token);
    await this.store.update(state => {
      const p = profile(state, id);
      if (p.epoch !== token.epoch || p.generation !== token.generation)
        return fail(
          'connection_changed',
          'Connection changed; refresh models again.'
        );
      p.models = models;
      p.verified = Object.fromEntries(
        Object.entries(p.verified).filter(([slug]) =>
          models.some(m => m.slug === slug)
        )
      );
    });
    return models;
  }
  async session(keyHash: string): Promise<Session> {
    const state = this.store.snapshot();
    if (!state.enabled)
      return fail('disabled', 'AI extension is disabled.', 503);
    if (!state.selected)
      return fail(
        'model_not_selected',
        'Select a verified default model.',
        503
      );
    const { profileId, model } = state.selected;
    const token = await this.token(profileId);
    const current = this.store.snapshot();
    const p = profile(current, profileId);
    if (
      !current.enabled ||
      p.epoch !== token.epoch ||
      current.selected?.profileId !== profileId ||
      current.selected.model !== model ||
      !p.models.some(m => m.slug === model) ||
      !['text', 'structured', 'tools'].every(c =>
        p.verified[model]?.includes(c)
      )
    ) {
      return fail(
        'selection_changed',
        'Default model changed or needs verification; retry after configuring it.',
        409
      );
    }
    return {
      profileId,
      model,
      epoch: token.epoch,
      accessToken: token.token,
      scope: keyHash + ':' + profileId + ':' + token.epoch + ':' + model,
    };
  }
  async verify(id: string, model: string) {
    const p = profile(this.store.snapshot(), id);
    if (!p.models.some(m => m.slug === model))
      return fail(
        'unknown_model',
        'Refresh the catalog and choose a listed model.'
      );
    const token = await this.token(id);
    const session: Session = {
      profileId: id,
      model,
      epoch: token.epoch,
      accessToken: token.token,
      scope: 'probe:' + randomUUID(),
    };
    const base = { model: 'chatgpt-default', stream: false };
    const text = await this.responses.run(
      { ...base, input: 'Reply with exactly GATEWAY_OK.' },
      session
    );
    if (!JSON.stringify(text.output).includes('GATEWAY_OK'))
      return fail('probe_failed', 'Text capability probe failed.');
    const structured = await this.responses.run(
      {
        ...base,
        input: 'Return an object with ok set to true.',
        text: {
          format: {
            type: 'json_schema',
            name: 'probe',
            strict: true,
            schema: {
              type: 'object',
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
              additionalProperties: false,
            },
          },
        },
      },
      session
    );
    const content = structured.output
      .flatMap((item: Json) => item.content ?? [])
      .map((part: Json) => part.text ?? '')
      .join('');
    try {
      if (JSON.parse(content).ok !== true) throw new Error();
    } catch {
      return fail('probe_failed', 'Structured capability probe failed.');
    }
    const tool = {
      type: 'function',
      name: 'gateway_probe',
      description: 'Return a probe value.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    };
    const call = await this.responses.run(
      {
        ...base,
        input: 'Call gateway_probe.',
        tools: [tool],
        tool_choice: { type: 'function', name: 'gateway_probe' },
      },
      session
    );
    const calls: Json[] = call.output.filter(
      (item: Json) => item.type === 'function_call'
    );
    if (!calls.length || calls.some(item => item.name !== 'gateway_probe'))
      return fail('probe_failed', 'Tool capability probe failed.');
    await this.responses.run(
      {
        ...base,
        tools: [tool],
        input: calls.map(item => ({
          type: 'function_call_output',
          call_id: item.call_id,
          output: 'GATEWAY_TOOL_OK',
        })),
      },
      session
    );
    await this.store.update(state => {
      const current = profile(state, id);
      if (
        current.epoch !== token.epoch ||
        !current.models.some(m => m.slug === model)
      )
        return fail(
          'connection_changed',
          'Connection changed during verification.'
        );
      current.verified[model] = ['text', 'structured', 'tools'];
    });
    return { model, capabilities: ['text', 'structured', 'tools'] };
  }
  async command(command: Json): Promise<unknown> {
    const id = String(command.profileId ?? '');
    switch (command.action) {
      case 'status':
        return this.status();
      case 'import':
        return this.import(command.record ?? {});
      case 'models':
        return this.refreshModels(id);
      case 'verify':
        return this.verify(id, String(command.model ?? ''));
      case 'select': {
        await this.store.update(state => {
          const p = profile(state, id);
          if (
            p.status !== 'connected' ||
            !p.models.some(m => m.slug === command.model) ||
            !['text', 'structured', 'tools'].every(c =>
              p.verified[command.model]?.includes(c)
            )
          )
            return fail(
              'model_unverified',
              'Run verify for this model before selecting it.'
            );
          state.selected = { profileId: id, model: command.model };
          state.enabled = true;
        });
        this.responses.continuations.clear();
        return { selected: this.status().selected };
      }
      case 'enable':
      case 'disable':
        await this.store.update(state => {
          state.enabled = command.action === 'enable';
        });
        this.responses.continuations.clear();
        return { enabled: this.status().enabled };
      case 'key': {
        // Only accessible through the container-local control socket, never HTTP.
        return this.store.update(state => {
          if (!state.accessKey || command.rotate === true)
            state.accessKey = randomBytes(32).toString('base64url');
          return { key: state.accessKey };
        });
      }
      case 'disconnect': {
        const result = await this.store.update(async state => {
          const p = profile(state, id);
          const remoteRevocationConfirmed = await this.upstream.revoke(p);
          delete p.tokens;
          p.models = [];
          p.verified = {};
          p.status = 'signed_out';
          p.generation++;
          p.epoch = randomUUID();
          return { remoteRevocationConfirmed };
        });
        this.responses.continuations.clear();
        return result;
      }
      default:
        return fail('unknown_command', 'Unknown management command.');
    }
  }
}
