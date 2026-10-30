import { expect, test, vi } from 'vitest';

vi.stubGlobal('environment', { isSelfHosted: true });
vi.mock('./operations/auth-signing-keys', () => ({
  AuthSigningKeys: () => null,
}));
vi.mock('./operations/send-test-email', () => ({ SendTestEmail: () => null }));

test('admin retains AI policies and exposes the existing ChatGPT switch', async () => {
  const { KNOWN_CONFIG_GROUPS } = await import('./config');
  const group = KNOWN_CONFIG_GROUPS.find(group => group.module === 'copilot')!;
  const keys = group.fields.map(field =>
    typeof field === 'string' ? field : field.key
  );
  expect(keys).toEqual(
    expect.arrayContaining([
      'enabled',
      'chatgptEnabled',
      'byok.enabled',
      'byok.allowCustomEndpoint',
      'byok.allowPrivateEndpoint',
    ])
  );
});
