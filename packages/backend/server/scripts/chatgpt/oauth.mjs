import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { createLocalJWKSet, jwtVerify } from 'jose';

export const AUTH = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const SCOPES =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

export function sameState(actual, expected) {
  const a = Buffer.from(actual ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authorizeUrl({
  clientId,
  hostId,
  state,
  nonce,
  verifier,
  redirectUri,
  consent,
}) {
  const url = new URL(`${AUTH}/api/accounts/authorize`);
  const params = {
    client_id: clientId ?? 'dynamic_agent_client',
    ext_agent_host_id: hostId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
  if (!clientId) params.agent_name_hint = 'AFFiNE';
  if (consent) params.prompt = 'consent';
  url.search = new URLSearchParams(params).toString();
  return url;
}

export function callbackResult(url, { state, clientId }) {
  if (!sameState(url.searchParams.get('state'), state))
    throw new Error('OAuth state mismatch');
  if (url.searchParams.has('error'))
    throw new Error('ChatGPT authorization was declined or cancelled');
  const returned = url.searchParams.get('client_id');
  if (clientId && returned && returned !== clientId)
    throw new Error('OAuth registration changed');
  const issued = clientId ?? returned;
  const code = url.searchParams.get('code');
  if (!issued || issued === 'dynamic_agent_client' || !code)
    throw new Error('Incomplete OAuth registration');
  return { clientId: issued, code };
}

async function jsonRequest(url, options) {
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.any([
      AbortSignal.timeout(20_000),
      ...(options?.signal ? [options.signal] : []),
    ]),
  });
  if (!response.ok)
    throw new Error(
      `ChatGPT authorization service returned HTTP ${response.status}`
    );
  return await response.json();
}

export async function signIn({
  hostId,
  registration,
  openBrowser,
  rememberClient,
  consent,
  signal,
}) {
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  let resolveCallback;
  let rejectCallback;
  const callback = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  // Attach immediately so cancellation cannot produce an unhandled rejection.
  void callback.catch(() => {});
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (
      req.method !== 'GET' ||
      url.pathname !== '/auth/callback' ||
      !sameState(url.searchParams.get('state'), state)
    ) {
      res.writeHead(400).end('Invalid authorization callback.');
      return;
    }
    try {
      const result = callbackResult(url, {
        state,
        clientId: registration?.clientId,
      });
      resolveCallback(result);
      res
        .writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        .end('Authorization received. Return to the AFFiNE connection helper.');
    } catch (error) {
      res.writeHead(400).end('Authorization was not completed.');
      rejectCallback(error);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
  const cancel = () =>
    rejectCallback(new Error('ChatGPT authorization cancelled'));
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(
    () => rejectCallback(new Error('ChatGPT authorization timed out')),
    5 * 60_000
  );
  try {
    if (signal?.aborted) throw new Error('ChatGPT authorization cancelled');
    await openBrowser(
      authorizeUrl({
        clientId: registration?.clientId,
        hostId,
        state,
        nonce,
        verifier,
        redirectUri,
        consent,
      }).href
    );
    const { code, clientId } = await callback;
    // Remember the issued ID before exchange, even if the one-time code expires.
    await rememberClient(clientId);
    const tokens = await jsonRequest(`${AUTH}/api/accounts/oauth/token`, {
      method: 'POST',
      signal,
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: RESOURCE,
      }),
    });
    const discovery = await jsonRequest(
      `${AUTH}/.well-known/openid-configuration`
    );
    if (!discovery.jwks_uri?.startsWith(`${AUTH}/`))
      throw new Error('Unexpected OpenAI signing-key endpoint');
    const jwks = createLocalJWKSet(await jsonRequest(discovery.jwks_uri));
    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer: AUTH,
      audience: clientId,
      algorithms: ['RS256', 'ES256'],
      requiredClaims: ['exp', 'sub', 'iss', 'aud', 'nonce'],
    });
    if (payload.nonce !== nonce || !payload.sub)
      throw new Error('ChatGPT identity or nonce mismatch');
    if (
      registration?.subject &&
      (registration.subject !== payload.sub ||
        registration.issuer !== payload.iss)
    ) {
      throw new Error(
        'Returning ChatGPT account does not match the saved connection'
      );
    }
    if (
      !tokens.access_token ||
      !tokens.refresh_token ||
      !Number.isSafeInteger(tokens.expires_in) ||
      tokens.expires_in <= 0
    ) {
      throw new Error('ChatGPT returned incomplete credentials');
    }
    return {
      client_id: clientId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token,
      scope: tokens.scope ?? '',
      expires_in: tokens.expires_in,
      saved_at: new Date().toISOString(),
      nonce,
      expected_generation: registration?.generation ?? -1,
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
