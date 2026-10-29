import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, before, mock, test } from 'node:test';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import {
  AUTH,
  authorizeUrl,
  callbackResult,
  RESOURCE,
  SCOPES,
  signIn,
} from './oauth.mjs';

const realFetch = globalThis.fetch;
let privateKey;
let jwk;
before(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256' };
});
afterEach(() => mock.restoreAll());

test('PKCE, stable host identity, scopes and returning client registration', () => {
  const params = {
    hostId: 'urn:uuid:fixture',
    state: 'state',
    nonce: 'nonce',
    verifier: 'verifier',
    redirectUri: 'http://127.0.0.1:1234/auth/callback',
  };
  const first = authorizeUrl(params).searchParams;
  assert.equal(first.get('client_id'), 'dynamic_agent_client');
  assert.equal(first.get('agent_name_hint'), 'AFFiNE');
  assert.equal(
    first.get('code_challenge'),
    createHash('sha256').update('verifier').digest('base64url')
  );
  assert.equal(first.get('code_challenge_method'), 'S256');
  assert.equal(first.get('scope'), SCOPES);
  assert.equal(first.get('resource'), RESOURCE);
  const returning = authorizeUrl({
    ...params,
    clientId: 'issued',
    consent: true,
  }).searchParams;
  assert.equal(returning.get('client_id'), 'issued');
  assert.equal(returning.get('ext_agent_host_id'), params.hostId);
  assert.equal(returning.get('prompt'), 'consent');
  assert.equal(returning.has('agent_name_hint'), false);
});

test('callbacks reject missing/mismatched state, denial and a changed client', () => {
  const callback = params =>
    new URL(`http://127.0.0.1/auth/callback?${params}`);
  for (const params of [
    'code=x&client_id=issued',
    'state=wrong&code=x',
    'state=state&error=access_denied',
    'state=state&code=x&client_id=dynamic_agent_client',
  ]) {
    assert.throws(() => callbackResult(callback(params), { state: 'state' }));
  }
  assert.throws(() =>
    callbackResult(callback('state=state&code=x&client_id=other'), {
      state: 'state',
      clientId: 'issued',
    })
  );
  assert.deepEqual(
    callbackResult(callback('state=state&code=x&client_id=issued'), {
      state: 'state',
    }),
    { clientId: 'issued', code: 'x' }
  );
});

async function flow({
  claims = {},
  registration,
  callbackError,
  cancel = false,
} = {}) {
  let authorization;
  let remembered;
  let exchanges = 0;
  const controller = new AbortController();
  mock.method(globalThis, 'fetch', async (url, options) => {
    const address = String(url);
    if (address === `${AUTH}/api/accounts/oauth/token`) {
      exchanges++;
      assert.equal(remembered, 'issued'); // Persisted before the one-time exchange.
      assert.equal(options.body.get('client_id'), 'issued');
      assert.equal(
        options.body.get('redirect_uri'),
        authorization.searchParams.get('redirect_uri')
      );
      assert.equal(
        createHash('sha256')
          .update(options.body.get('code_verifier'))
          .digest('base64url'),
        authorization.searchParams.get('code_challenge')
      );
      const idToken = await new SignJWT({
        nonce: authorization.searchParams.get('nonce'),
        ...claims,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(claims.iss ?? AUTH)
        .setAudience(claims.aud ?? 'issued')
        .setSubject(claims.sub ?? 'subject')
        .setExpirationTime(claims.exp ?? '5m')
        .sign(privateKey);
      return Response.json({
        access_token: 'test-access',
        refresh_token: 'test-refresh',
        id_token: idToken,
        expires_in: 3600,
        scope: SCOPES,
      });
    }
    if (address === `${AUTH}/.well-known/openid-configuration`)
      return Response.json({ jwks_uri: `${AUTH}/keys` });
    if (address === `${AUTH}/keys`) return Response.json({ keys: [jwk] });
    throw new Error('Unexpected outbound endpoint');
  });
  const result = await signIn({
    hostId: 'urn:uuid:fixture',
    registration,
    signal: controller.signal,
    rememberClient: async id => {
      remembered = id;
    },
    openBrowser: async url => {
      authorization = new URL(url);
      const callback = new URL(authorization.searchParams.get('redirect_uri'));
      assert.equal(callback.hostname, '127.0.0.1');
      callback.searchParams.set('state', 'wrong');
      assert.equal((await realFetch(callback)).status, 400);
      if (cancel) {
        controller.abort();
        return;
      }
      callback.searchParams.set(
        'state',
        authorization.searchParams.get('state')
      );
      if (callbackError) callback.searchParams.set('error', callbackError);
      else {
        callback.searchParams.set('code', 'one-time-code');
        callback.searchParams.set('client_id', 'issued');
      }
      await realFetch(callback);
    },
  });
  assert.equal(exchanges, 1);
  return result;
}

test('loopback login validates a signed ID token and returns one transfer record', async () => {
  const record = await flow();
  assert.equal(record.client_id, 'issued');
  assert.equal(record.access_token, 'test-access');
  assert.equal(record.expected_generation, -1);
  assert.equal(record.scope, SCOPES);
});
test('returning registration preserves identity and import generation', async () => {
  const record = await flow({
    registration: {
      clientId: 'issued',
      issuer: AUTH,
      subject: 'subject',
      generation: 8,
    },
  });
  assert.equal(record.expected_generation, 8);
});
test('recovery reuses an issued client with a fresh validated login before first import', async () => {
  const record = await flow({ registration: { clientId: 'issued' } });
  assert.equal(record.client_id, 'issued');
  assert.equal(record.expected_generation, -1);
});
test('ID token nonce, issuer, audience, expiration and returning identity are checked', async () => {
  for (const claims of [
    { nonce: 'wrong' },
    { iss: 'https://evil.test' },
    { aud: 'other' },
    { exp: 1 },
  ]) {
    await assert.rejects(flow({ claims }));
    mock.restoreAll();
  }
  await assert.rejects(
    flow({
      registration: {
        clientId: 'issued',
        issuer: AUTH,
        subject: 'another-user',
      },
    }),
    /does not match/
  );
});
test('denied authorization and cancellation close the listener without exchange', async () => {
  await assert.rejects(
    flow({ callbackError: 'access_denied' }),
    /declined|cancelled/
  );
  mock.restoreAll();
  await assert.rejects(flow({ cancel: true }), /cancelled/);
});
test('authorization timeout closes the listener without exchanging or saving credentials', async () => {
  let callback;
  const requests = mock.method(globalThis, 'fetch', () => {
    throw new Error('No token exchange expected');
  });
  await assert.rejects(
    signIn({
      hostId: 'urn:uuid:test-timeout',
      timeoutMs: 25,
      openBrowser: async url => {
        callback = new URL(url).searchParams.get('redirect_uri');
      },
      rememberClient: async () => {
        assert.fail('No registration received');
      },
    }),
    /timed out/
  );
  assert.equal(requests.mock.callCount(), 0);
  await assert.rejects(realFetch(callback));
});
