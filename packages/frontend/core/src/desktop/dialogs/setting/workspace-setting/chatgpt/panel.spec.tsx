/** @vitest-environment happy-dom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ButtonHTMLAttributes } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { ChatgptConnectionPanel } from './panel';

vi.mock('@affine/component', () => ({
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} />
  ),
}));
afterEach(cleanup);

const profile = {
  id: '57128a30-c354-4b6f-abf2-e5596508ac1e',
  email: 'personal@example.test',
  active: false,
  status: 'connected',
  defaultModel: null,
  models: [{ slug: 'dynamic-model', displayName: 'Dynamic model' }],
};
const response = (profiles = [profile], enabled = true) =>
  Response.json({ enabled, userId: 'user-fixture', profiles });

test('login instructions contain only user and profile references', async () => {
  render(<ChatgptConnectionPanel fetcher={vi.fn(async () => response([]))} />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Continue with ChatGPT' })
  );
  expect(screen.getByText(/node packages/).textContent).toContain(
    '--user-id user-fixture'
  );
  expect(screen.getByText(/node packages/).textContent).not.toContain('token');
  expect(
    screen.getByRole('link', { name: 'Manage usage' }).getAttribute('href')
  ).toBe('https://chatgpt.com/settings/usage');
});

test('selection uses a discovered model and refreshes status after success', async () => {
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) =>
    options?.method === 'POST'
      ? Response.json({ remoteRevocationConfirmed: true })
      : response()
  );
  render(<ChatgptConnectionPanel fetcher={fetcher} />);
  const select = await screen.findByRole('combobox');
  expect(
    (
      screen.getByRole('button', {
        name: 'Use ChatGPT plan',
      }) as HTMLButtonElement
    ).disabled
  ).toBe(true);
  fireEvent.change(select, { target: { value: 'dynamic-model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use ChatGPT plan' }));
  await screen.findByRole('status');
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(JSON.parse(fetcher.mock.calls[1][1]?.body as string)).toEqual({
    action: 'select',
    profileId: profile.id,
    model: 'dynamic-model',
  });
  expect(screen.getByRole('status').textContent).toContain(
    'Reopen your desktop AI chat'
  );
});

test('disconnect reports unconfirmed revocation and never silently changes billing', async () => {
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) =>
    options?.method === 'POST'
      ? Response.json({ remoteRevocationConfirmed: false })
      : response([{ ...profile, active: true }])
  );
  render(<ChatgptConnectionPanel fetcher={fetcher} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
  expect((await screen.findByRole('status')).textContent).toContain(
    'Remote revocation was not confirmed'
  );
  expect(
    fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')
  ).toHaveLength(1);
  expect(
    screen.getByRole('button', { name: 'Use other configured providers' })
  ).toBeTruthy();
});

test('disabled server and failed mutation expose actionable states', async () => {
  const view = render(
    <ChatgptConnectionPanel fetcher={async () => response([], false)} />
  );
  await screen.findByText(/Enable personal ChatGPT connections/);
  expect(
    screen.queryByRole('button', { name: 'Continue with ChatGPT' })
  ).toBeNull();
  view.unmount();
  render(
    <ChatgptConnectionPanel
      fetcher={async (_url, options) =>
        options?.method === 'POST'
          ? new Response('', { status: 400 })
          : response()
      }
    />
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Refresh models' })
  );
  await screen.findByRole('alert');
  await waitFor(() =>
    expect(
      (
        screen.getByRole('button', {
          name: 'Refresh models',
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)
  );
  expect(screen.queryByRole('status')).toBeNull();
});
