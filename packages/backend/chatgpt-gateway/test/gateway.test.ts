import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Accounts } from '../src/accounts.ts';
import { control } from '../src/control.ts';
import { OpenAI, PLAN_SCOPE, RESOURCE } from '../src/openai.ts';
import {
  CompletionGuard,
  Continuations,
  normalize,
  Responses,
} from '../src/protocol.ts';
import { startGateway } from '../src/server.ts';
import { textCandidates } from '../src/setup.ts';
import { Store } from '../src/store.ts';
import type { Json, Profile, Session } from '../src/types.ts';
import { GatewayError } from '../src/util.ts';

const profile = (): Profile => ({
  id: 'profile-1',
  clientId: 'issued',
  issuer: 'https://auth.openai.com',
  subject: 'me',
  email: 'test@example.invalid',
  generation: 0,
  epoch: 'epoch-1',
  status: 'connected',
  expiresAt: Date.now() + 3600_000,
  scopes: [PLAN_SCOPE],
  tokens: {
    access: 'secret-access',
    refresh: 'secret-refresh',
    identity: 'secret-identity',
  },
  models: [
    { slug: 'test-model', displayName: 'Test', inputModalities: ['text'] },
  ],
  verified: { 'test-model': ['text', 'structured', 'tools'] },
});
const session: Session = {
  profileId: 'p1',
  epoch: 'e1',
  model: 'test-model',
  accessToken: 'token',
  scope: 'key:p1:e1:test-model',
};
const message = (text = 'hello') => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text }],
});
const call = (id = 'call1') => ({
  id: 'item_' + id,
  type: 'function_call',
  call_id: id,
  name: 'read_doc',
  arguments: '{}',
});
const complete = (output: Json[]) => ({
  type: 'response.completed',
  response: {
    id: 'resp1',
    model: 'upstream',
    status: 'completed',
    output,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
});
const frames = (events: Json[]) =>
  events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('');

function fake(events: Json[][]) {
  const requests: Json[] = [];
  const upstream = new OpenAI((async (url, init) => {
    assert.equal(url, RESOURCE + '/responses');
    requests.push(JSON.parse(init!.body as string));
    return new Response(frames(events.shift() ?? [complete([message()])]), {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof fetch);
  return { upstream, requests, responses: new Responses(upstream) };
}
async function stateFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'gw-'));
  const state = join(dir, 'state.enc');
  const key = join(dir, 'key');
  const store = await Store.load(state, key);
  await store.update(s => {
    s.profiles = [profile()];
    s.selected = { profileId: 'profile-1', model: 'test-model' };
    s.accessKey = 'gateway-key';
  });
  return {
    dir,
    state,
    key,
    store,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

await test('normalization removes preview parameters, retains schema and uses developer tools', () => {
  const result = normalize(
    {
      model: 'alias',
      stream: false,
      temperature: 0.5,
      max_output_tokens: 10,
      input: [{ role: 'system', content: 'instruction' }],
      tools: [{ type: 'function', name: 'read' }],
      text: { format: { type: 'json_schema' } },
    },
    'actual'
  );
  assert.equal(result.model, 'actual');
  assert.equal(result.store, false);
  assert.equal(result.stream, true);
  assert.equal(result.temperature, undefined);
  assert.equal(result.input[0].type, 'additional_tools');
  assert.equal(result.input[1].role, 'developer');
  assert.equal(result.text.format.type, 'json_schema');
  assert.throws(
    () =>
      normalize(
        { input: [{ role: 'user', content: [{ type: 'input_image' }] }] },
        'm'
      ),
    /text input/
  );
  assert.throws(
    () => normalize({ input: [], tools: [{ type: 'web_search' }] }, 'm'),
    /function tools/
  );
});

await test('SSE handles split frames, sparse completion and item-to-call identity', () => {
  const guard = new CompletionGuard();
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: call() },
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'item_call1',
      delta: '{}',
    },
    { type: 'response.output_item.done', output_index: 0, item: call() },
    complete([]),
  ];
  const input = frames(events);
  const decoded = [];
  for (let index = 0; index < input.length; index += 7)
    decoded.push(...guard.push(input.slice(index, index + 7)));
  assert.equal(decoded[1].call_id, 'call1');
  assert.equal(guard.finish().output[0].call_id, 'call1');
});

await test('SSE rejects incomplete, malformed, missing items and events after completion', () => {
  for (const type of [
    'response.failed',
    'response.incomplete',
    'response.error',
    'error',
  ]) {
    assert.throws(
      () => new CompletionGuard().push(frames([{ type }])),
      /did not complete/
    );
  }
  assert.throws(
    () => new CompletionGuard().push('data: invalid\n\n'),
    /Malformed/
  );
  assert.throws(() => new CompletionGuard().finish(), /before completion/);
  assert.throws(
    () =>
      new CompletionGuard().push(
        frames([
          { type: 'response.output_item.done', output_index: 1, item: call() },
          complete([]),
        ])
      ),
    /Missing finalized/
  );
  assert.throws(
    () =>
      new CompletionGuard().push(
        frames([complete([]), { type: 'response.created' }])
      ),
    /Unexpected/
  );
});

await test('non-streaming requests consume upstream SSE and return full JSON', async () => {
  const mock = fake([[complete([message()])]]);
  const result = await mock.responses.run(
    { model: 'chatgpt-default', input: 'hi', stream: false },
    session
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.model, 'chatgpt-default');
  assert.equal(result.output[0].content[0].text, 'hello');
  assert.equal(mock.requests[0].stream, true);
});

await test('parallel tool continuations preserve raw reasoning and isolate opaque call IDs', async () => {
  const reasoning = {
    type: 'reasoning',
    encrypted_content: 'private-reasoning',
    id: 'rs1',
    summary: [],
  };
  const mock = fake([
    [complete([reasoning, call('a'), call('b')])],
    [complete([call('c')])],
    [complete([message('done')])],
  ]);
  const first = await mock.responses.run(
    { model: 'chatgpt-default', input: 'read twice' },
    session
  );
  assert.equal(JSON.stringify(first).includes('private-reasoning'), false);
  const outputs = first.output
    .filter((x: Json) => x.type === 'function_call')
    .map((x: Json) => ({
      type: 'function_call_output',
      call_id: x.call_id,
      output: 'doc',
    }));
  assert.notEqual(outputs[0].call_id, 'a');
  await assert.rejects(
    mock.responses.run(
      { model: 'chatgpt-default', input: outputs.slice(0, 1) },
      session
    ),
    /Every outstanding/
  );
  await assert.rejects(
    mock.responses.run(
      { model: 'chatgpt-default', input: outputs },
      { ...session, scope: 'other-account' }
    ),
    /different connection/
  );
  const second = await mock.responses.run(
    { model: 'chatgpt-default', input: outputs },
    session
  );
  assert.equal(
    mock.requests[1].input[1].encrypted_content,
    'private-reasoning'
  );
  assert.equal(mock.requests[1].input[4].call_id, 'a');
  const result = await mock.responses.run(
    {
      model: 'chatgpt-default',
      input: [
        ...outputs,
        {
          type: 'function_call_output',
          call_id: second.output[0].call_id,
          output: 'updated',
        },
      ],
    },
    session
  );
  assert.equal(result.output[0].content[0].text, 'done');
  await assert.rejects(
    mock.responses.run({ model: 'chatgpt-default', input: outputs }, session),
    /missing, mixed, or expired/
  );
});

await test('concurrent conversation chains cannot be mixed and restart loses only temporary contexts', async () => {
  const mock = fake([[complete([call('a')])], [complete([call('a')])]]);
  const [a, b] = await Promise.all([
    mock.responses.run({ model: 'chatgpt-default', input: 'first' }, session),
    mock.responses.run({ model: 'chatgpt-default', input: 'second' }, session),
  ]);
  const input = [a, b].map(r => ({
    type: 'function_call_output',
    call_id: r.output[0].call_id,
    output: 'result',
  }));
  await assert.rejects(
    mock.responses.run({ model: 'chatgpt-default', input }, session),
    /mixed/
  );
  mock.responses.continuations.clear();
  await assert.rejects(
    mock.responses.run(
      { model: 'chatgpt-default', input: input.slice(0, 1) },
      session
    ),
    /expired/
  );
});

await test('continuations enforce TTL and simultaneous-use guard', async () => {
  const cache = new Continuations(-1);
  cache.commit('s', [], { output: [call()] }, new Map([['call1', 'opaque']]));
  assert.throws(
    () =>
      cache.begin('s', [{ type: 'function_call_output', call_id: 'opaque' }]),
    /expired/
  );
  const live = new Continuations();
  live.commit('s', [], { output: [call()] }, new Map([['call1', 'opaque']]));
  live.begin('s', [{ type: 'function_call_output', call_id: 'opaque' }]);
  assert.throws(
    () =>
      live.begin('s', [{ type: 'function_call_output', call_id: 'opaque' }]),
    /already running/
  );
});

await test('state is encrypted, atomic, survives reload and rejects wrong/missing keys', async () => {
  const f = await stateFixture();
  try {
    const disk = await readFile(f.state, 'utf8');
    for (const value of [
      'secret-access',
      'secret-refresh',
      'gateway-key',
      'test@example.invalid',
    ])
      assert.equal(disk.includes(value), false);
    assert.equal((await stat(f.state)).mode & 0o777, 0o600);
    assert.equal(
      (await Store.load(f.state, f.key)).snapshot().profiles[0].tokens!.refresh,
      'secret-refresh'
    );
    await assert.rejects(Store.load(f.state, join(f.dir, 'missing-key')));
    await Promise.all(
      Array.from({ length: 8 }, () =>
        f.store.update(s => {
          s.profiles[0].generation++;
        })
      )
    );
    assert.equal(f.store.snapshot().profiles[0].generation, 8);
  } finally {
    await f.cleanup();
  }
});

await test('concurrent token requests refresh once and persist rotated credentials before use', async () => {
  const f = await stateFixture();
  try {
    await f.store.update(s => {
      s.profiles[0].expiresAt = 1;
    });
    let count = 0;
    const upstream = new OpenAI();
    upstream.refresh = async () => {
      count++;
      return {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      };
    };
    const accounts = new Accounts(f.store, upstream, new Responses(upstream));
    const results = await Promise.all(
      Array.from({ length: 5 }, () => accounts.token('profile-1'))
    );
    assert.equal(count, 1);
    assert.ok(results.every(result => result.token === 'new-access'));
    assert.equal(
      (await Store.load(f.state, f.key)).snapshot().profiles[0].tokens!.refresh,
      'new-refresh'
    );
  } finally {
    await f.cleanup();
  }
});

await test('temporary refresh errors retain credentials; invalid grants clear them and fail closed', async () => {
  const f = await stateFixture();
  try {
    await f.store.update(s => {
      s.profiles[0].expiresAt = 1;
    });
    const upstream = new OpenAI();
    const accounts = new Accounts(f.store, upstream, new Responses(upstream));
    upstream.refresh = async () => {
      throw new GatewayError('refresh_unavailable', 'try later', 429);
    };
    await assert.rejects(accounts.token('profile-1'));
    assert.ok(f.store.snapshot().profiles[0].tokens);
    upstream.refresh = async () => {
      throw new GatewayError('reauth_required', 'sign in', 401);
    };
    await assert.rejects(accounts.token('profile-1'));
    assert.equal(f.store.snapshot().profiles[0].tokens, undefined);
    assert.equal(f.store.snapshot().selected?.profileId, 'profile-1');
    assert.equal(f.store.snapshot().profiles[0].status, 'reauth_required');
  } finally {
    await f.cleanup();
  }
});

await test('import verifies identity, rejects stale generations and retains routing after sign-out', async () => {
  const f = await stateFixture();
  try {
    const upstream = new OpenAI();
    upstream.identity = async () => ({
      issuer: 'https://auth.openai.com',
      subject: 'me',
      email: 'test@example.invalid',
    });
    upstream.revoke = async () => false;
    const accounts = new Accounts(f.store, upstream, new Responses(upstream));
    const record = {
      client_id: 'issued',
      expected_generation: 0,
      access_token: 'new',
      refresh_token: 'new-r',
      id_token: 'signed',
      nonce: 'nonce',
      scope: PLAN_SCOPE,
      saved_at: new Date().toISOString(),
      expires_in: 3600,
    };
    await accounts.import(record);
    await assert.rejects(accounts.import(record), /Connection changed/);
    upstream.identity = async () => ({
      issuer: 'https://auth.openai.com',
      subject: 'another',
      email: '',
    });
    await assert.rejects(
      accounts.import({ ...record, expected_generation: 1 }),
      /identity changed/
    );
    assert.deepEqual(
      await accounts.command({ action: 'disconnect', profileId: 'profile-1' }),
      { remoteRevocationConfirmed: false }
    );
    assert.equal(f.store.snapshot().profiles[0].tokens, undefined);
    assert.equal(f.store.snapshot().selected?.profileId, 'profile-1');
  } finally {
    await f.cleanup();
  }
});

await test('HTTP surface requires gateway key, rejects management, supports JSON/SSE and disabled state', async () => {
  const f = await stateFixture();
  const mock = fake([
    [complete([message()])],
    [
      { type: 'response.output_text.delta', delta: 'hello' },
      complete([message()]),
    ],
  ]);
  const socket = join(f.dir, 'control.sock');
  const gateway = await startGateway({
    statePath: f.state,
    keyPath: f.key,
    socketPath: socket,
    port: 0,
    host: '127.0.0.1',
    upstream: mock.upstream,
  });
  const base =
    'http://127.0.0.1:' +
    (gateway.api.address() as import('node:net').AddressInfo).port;
  try {
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal((await fetch(base + '/v1/models')).status, 401);
    assert.equal(
      (
        await fetch(base + '/command', {
          headers: { Authorization: 'Bearer gateway-key' },
        })
      ).status,
      404
    );
    for (const stream of [false, true]) {
      const result = await fetch(base + '/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer gateway-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'chatgpt-default', input: 'hi', stream }),
      });
      assert.equal(result.status, 200);
      const body = await result.text();
      assert.ok(body.includes('hello'));
      if (stream) assert.ok(body.includes('response.completed'));
    }
    assert.equal((await stat(socket)).mode & 0o777, 0o600);
    await control({ action: 'disable' }, socket);
    const result = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer gateway-key' },
      body: JSON.stringify({ model: 'chatgpt-default', input: 'hi' }),
    });
    assert.equal(result.status, 503);
    assert.equal(
      JSON.stringify(await control({ action: 'status' }, socket)).includes(
        'secret-access'
      ),
      false
    );
  } finally {
    await gateway.close();
    await f.cleanup();
  }
});

await test('stream failures are explicit and never contain a successful completion', async () => {
  const mock = fake([
    [
      { type: 'response.output_text.delta', delta: 'partial' },
      { type: 'response.incomplete' },
    ],
  ]);
  const events: Json[] = [];
  await assert.rejects(
    mock.responses.run(
      { model: 'chatgpt-default', input: 'hi' },
      session,
      undefined,
      async e => {
        events.push(e);
      }
    )
  );
  assert.equal(
    events.some(e => e.type === 'response.completed'),
    false
  );
});

await test('upstream rate limits and cancellation propagate without fallback', async () => {
  let requests = 0;
  const upstream = new OpenAI((async (_url, options) => {
    requests++;
    if (options?.signal?.aborted) throw new Error('aborted');
    return new Response('{}', { status: 429, headers: { 'Retry-After': '5' } });
  }) as typeof fetch);
  const responses = new Responses(upstream);
  await assert.rejects(
    responses.run({ model: 'chatgpt-default', input: 'hi' }, session),
    (error: any) => error.status === 429 && error.retryAfter === '5'
  );
  await assert.rejects(
    responses.run(
      { model: 'chatgpt-default', input: 'hi' },
      session,
      AbortSignal.abort()
    )
  );
  assert.equal(requests, 2);
});

await test('setup identifies text candidates without treating image-only providers as fallback', () => {
  const p = (output: string) => ({
    enabled: true,
    definition: {
      models: [
        {
          enabled: true,
          capabilities: [{ input: ['text'], output: [output] }],
        },
      ],
    },
  });
  assert.equal(textCandidates([p('image'), p('text'), p('object')]).length, 2);
});
