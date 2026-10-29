// Run only against the fresh, disposable compose.chatgpt-test.yml server.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

const base = 'http://127.0.0.1:13010';
const statusPath = '/api/copilot/chatgpt';
const info = await (await fetch(`${base}/info`)).json();
assert.equal(info.type, 'selfhosted');
assert.equal((await fetch(base + statusPath)).status, 401);

const setup = await fetch(`${base}/api/setup/create-admin-user`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'ChatGPT image smoke test',
    email: 'chatgpt-smoke@example.test',
    password: `${randomBytes(18).toString('base64url')}aA1!`,
  }),
});
assert.equal(
  setup.status,
  201,
  'Smoke test requires a fresh disposable database'
);
const user = await setup.json();
const headers = {
  'Content-Type': 'application/json',
  Cookie: setup.headers
    .getSetCookie()
    .map(cookie => cookie.split(';')[0])
    .join('; '),
};
const status = await (await fetch(base + statusPath, { headers })).json();
assert.equal(typeof status.enabled, 'boolean');
assert.equal(status.userId, user.id);
assert.deepEqual(status.profiles, []);

for (const body of [
  { action: 'import', record: {} },
  { action: 'disable', profileId: randomUUID(), userId: 'another-user' },
  { action: 'disconnect', profileId: randomUUID() },
]) {
  const response = await fetch(base + statusPath, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 400);
}

const response = await fetch(`${base}/graphql`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    query: `query { currentUser { id copilot {
      routeOptions(promptName: "Chat With AFFiNE AI") {
        routeId defaultTargetId choices { id displayName minimumTier available }
      }
    } } }`,
  }),
});
const result = await response.json();
assert.equal(result.errors, undefined, JSON.stringify(result.errors));
assert.equal(result.data.currentUser.id, user.id);
assert.deepEqual(result.data.currentUser.copilot.routeOptions.choices, []);
console.log(
  'Passed: server startup, authentication, management boundary and desktop GraphQL contract.'
);
