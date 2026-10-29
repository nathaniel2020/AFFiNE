import { BadRequestException } from '@nestjs/common';
import test from 'ava';
import Sinon from 'sinon';

import type { CurrentUser } from '../../../core/auth';
import type { BackendRuntimeProvider } from '../../../core/backend-runtime';
import { ChatgptController } from './controller';
import { ChatgptService, chatgptTargetId } from './service';

const id = '57128a30-c354-4b6f-abf2-e5596508ac1e';
const profile = {
  id,
  email: 'personal@example.test',
  active: true,
  status: 'connected',
  defaultModel: 'dynamic-model',
  models: [{ slug: 'dynamic-model', displayName: 'Dynamic' }],
  clientId: 'issued-private-metadata',
  issuer: 'issuer',
  subject: 'subject',
  generation: 3,
};

test('Web projection and old desktop route shape contain no registration metadata', async t => {
  const chatgptCommand = Sinon.stub().resolves({
    enabled: true,
    profiles: [
      profile,
      { ...profile, id: 'signed-out', status: 'reauth_required' },
    ],
  });
  const service = new ChatgptService({
    chatgptCommand,
  } as unknown as BackendRuntimeProvider);
  const status = await service.status('affine-user');
  t.is(status.userId, 'affine-user');
  t.false(JSON.stringify(status).includes('issued-private-metadata'));
  const options = await service.routeOptions(
    'affine-user',
    'Chat With AFFiNE AI'
  );
  t.deepEqual(options, {
    routeId: 'Chat With AFFiNE AI',
    defaultTargetId: chatgptTargetId(id, 'dynamic-model'),
    choices: [
      {
        id: chatgptTargetId(id, 'dynamic-model'),
        displayName: 'ChatGPT Dynamic · personal@example.test',
        minimumTier: 'Standard',
        available: true,
      },
    ],
  });
  t.true(chatgptCommand.alwaysCalledWith('affine-user'));
  t.is(
    Buffer.from(options.choices[0].id.split(':')[2], 'base64url').toString(),
    'dynamic-model'
  );
});

test('HTTP management rejects token import and binds every operation to current user', async t => {
  const command = Sinon.stub().resolves({});
  const controller = new ChatgptController({
    command,
  } as unknown as ChatgptService);
  const user = { id: 'user-a' } as CurrentUser;
  await t.throwsAsync(
    controller.update(user, {
      action: 'import',
      record: { access_token: 'do-not-accept' },
    }),
    { instanceOf: BadRequestException }
  );
  await t.throwsAsync(
    controller.update(user, {
      action: 'select',
      profileId: id,
      userId: 'user-b',
    }),
    { instanceOf: BadRequestException }
  );
  t.false(command.called);
  await controller.update(user, {
    action: 'select',
    profileId: id,
    model: 'dynamic-model',
  });
  t.true(
    command.calledOnceWithExactly('user-a', {
      action: 'select',
      profileId: id,
      model: 'dynamic-model',
    })
  );
});

test('runtime error details never leak through the management API', async t => {
  const chatgptCommand = Sinon.stub().rejects(new Error('sensitive fixture'));
  const service = new ChatgptService({
    chatgptCommand,
  } as unknown as BackendRuntimeProvider);
  const error = await t.throwsAsync(
    service.command('user', { action: 'disconnect', profileId: id })
  );
  t.false(error?.message.includes('sensitive fixture'));
});
