import { createLocalJWKSet, jwtVerify } from 'jose';

import type { Json, Model, Profile } from './types.ts';
import { fail, GatewayError } from './util.ts';

export const AUTH = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export class OpenAI {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async request(url: string, options: RequestInit = {}) {
    try {
      return await this.fetcher(url, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.any([
          AbortSignal.timeout(120_000),
          ...(options.signal ? [options.signal] : []),
        ]),
      });
    } catch {
      throw new GatewayError(
        'upstream_unavailable',
        'ChatGPT is temporarily unavailable; the connection is retained.',
        502
      );
    }
  }
  async json(url: string, options: RequestInit = {}) {
    const response = await this.request(url, options);
    if (!response.ok)
      throw new GatewayError(
        'upstream_rejected',
        'ChatGPT rejected the request; check connection and usage settings.',
        response.status === 429 ? 429 : 502,
        response.headers.get('retry-after') ?? undefined
      );
    return (await response.json()) as Json;
  }
  async discovery() {
    return this.json(AUTH + '/.well-known/openid-configuration');
  }
  authEndpoint(document: Json, field: string) {
    const endpoint = document[field];
    if (typeof endpoint !== 'string' || !endpoint.startsWith(AUTH + '/')) {
      return fail(
        'invalid_discovery',
        'Unexpected OpenAI authorization endpoint.',
        502
      );
    }
    return endpoint;
  }
  async identity(token: string, clientId: string, nonce?: string) {
    try {
      const discovery = await this.discovery();
      const keys = await this.json(this.authEndpoint(discovery, 'jwks_uri'));
      const { payload } = await jwtVerify(
        token,
        createLocalJWKSet(keys as any),
        {
          issuer: AUTH,
          audience: clientId,
          algorithms: ['RS256', 'ES256'],
          requiredClaims: [
            'exp',
            'sub',
            'iss',
            'aud',
            ...(nonce ? ['nonce'] : []),
          ],
        }
      );
      if (!payload.sub || !payload.iss || (nonce && payload.nonce !== nonce))
        throw new Error();
      return {
        issuer: payload.iss,
        subject: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : '',
      };
    } catch {
      return fail('invalid_identity', 'ChatGPT identity verification failed.');
    }
  }
  async refresh(profile: Profile) {
    if (!profile.tokens)
      return fail('reauth_required', 'Reconnect ChatGPT.', 401);
    const response = await this.request(AUTH + '/api/accounts/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: profile.clientId,
        refresh_token: profile.tokens.refresh,
        resource: RESOURCE,
      }),
    });
    const body: Json = await response.json().catch(() => ({}));
    const code = typeof body.error === 'string' ? body.error : body.error?.code;
    if (!response.ok) {
      const terminal = [
        'invalid_grant',
        'invalid_refresh_token',
        'refresh_token_invalid',
        'token_expired',
        'refresh_token_expired',
        'refresh_token_invalidated',
        'refresh_token_reused',
      ].includes(code);
      throw new GatewayError(
        terminal ? 'reauth_required' : 'refresh_unavailable',
        terminal
          ? 'ChatGPT session expired; sign in again.'
          : 'Token refresh is temporarily unavailable; connection retained.',
        terminal ? 401 : response.status === 429 ? 429 : 502
      );
    }
    return body;
  }
  async models(token: string): Promise<Model[]> {
    const body = await this.json(RESOURCE + '/models', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!Array.isArray(body.models))
      return fail('invalid_catalog', 'Invalid ChatGPT model catalog.', 502);
    return body.models
      .filter(
        (model: Json) =>
          model.visibility === 'list' && typeof model.slug === 'string'
      )
      .map((model: Json) => ({
        slug: model.slug,
        displayName: model.display_name ?? model.slug,
        inputModalities: Array.isArray(model.input_modalities)
          ? model.input_modalities
          : ['text'],
      }));
  }
  async revoke(profile: Profile) {
    if (!profile.tokens) return true;
    try {
      const document = await this.discovery();
      const response = await this.request(
        this.authEndpoint(document, 'revocation_endpoint'),
        {
          method: 'POST',
          body: new URLSearchParams({
            token: profile.tokens.refresh,
            token_type_hint: 'refresh_token',
            client_id: profile.clientId,
          }),
        }
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}
