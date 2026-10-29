import { Button } from '@affine/component';
import { useCallback, useEffect, useState } from 'react';

import * as styles from './index.css';

type Profile = {
  id: string;
  email: string;
  active: boolean;
  status: string;
  defaultModel: string | null;
  models: { slug: string; displayName: string }[];
};
type Status = { enabled: boolean; userId: string; profiles: Profile[] };
type Fetcher = (url: string, options?: RequestInit) => Promise<Response>;

export function ChatgptConnectionPanel({ fetcher }: { fetcher: Fetcher }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [loginProfile, setLoginProfile] = useState<
    Profile | null | undefined
  >();
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetcher('/api/copilot/chatgpt', { signal });
      if (!response.ok) throw new Error('Could not load ChatGPT connections.');
      const next: Status = await response.json();
      if (!signal?.aborted) setStatus(next);
    },
    [fetcher]
  );
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch(error => {
      if (!controller.signal.aborted) setError(error.message);
    });
    return () => controller.abort();
  }, [load]);

  const run = async (action: string, profile: Profile, model?: string) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetcher('/api/copilot/chatgpt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          profileId: profile.id,
          ...(model ? { model } : {}),
        }),
      });
      if (!response.ok)
        throw new Error(
          'ChatGPT connection update failed. Check your connection and try again.'
        );
      const result = await response.json();
      await load();
      setMessage(
        result.remoteRevocationConfirmed === false
          ? 'Signed out locally. Remote revocation was not confirmed; disconnect AFFiNE in ChatGPT Settings → Security and login.'
          : action === 'select'
            ? "You're using your ChatGPT plan. Reopen your desktop AI chat to refresh its model list."
            : 'Connection updated. Reopen your desktop AI chat to refresh its model list.'
      );
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Connection update failed.'
      );
    } finally {
      setBusy(false);
    }
  };

  const command = status
    ? `node packages/backend/server/scripts/chatgpt-login.mjs --user-id ${status.userId}${loginProfile ? ` --profile-id ${loginProfile.id}` : ''}${loginProfile?.status === 'consent_required' ? ' --consent' : ''}`
    : '';

  return (
    <section className={styles.panel} aria-label="ChatGPT plan connection">
      <div className={styles.row}>
        <strong>Use your ChatGPT plan</strong>
        <a
          href="https://chatgpt.com/settings/usage"
          target="_blank"
          rel="noreferrer"
        >
          Manage usage
        </a>
      </div>
      <p className={styles.description}>
        Connect your own ChatGPT account for eligible AI requests. This uses
        your ChatGPT plan or credits, separately from AFFiNE AI and API-key
        providers.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {message ? <p role="status">{message}</p> : null}
      {!status ? (
        <span>Loading connections…</span>
      ) : !status.enabled ? (
        <p className={styles.description}>
          Enable personal ChatGPT connections in your self-hosted server
          configuration to get started.
        </p>
      ) : (
        <>
          <div className={styles.row}>
            <Button disabled={busy} onClick={() => setLoginProfile(null)}>
              Continue with ChatGPT
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setError('');
                load().catch(error => setError(error.message));
              }}
            >
              Refresh connections
            </Button>
          </div>
          {loginProfile !== undefined ? (
            <div>
              <p className={styles.description}>
                Run this helper from your AFFiNE source checkout on the computer
                running Docker. It opens the official login in your browser and
                securely imports the connection into your server.
              </p>
              <pre className={styles.command}>{command}</pre>
              <p className={styles.description}>
                After authorization, refresh connections, refresh the model
                list, then choose a default model. Your existing AFFiNE desktop
                installation can keep using its usual AI controls.
              </p>
              <Button onClick={() => setLoginProfile(undefined)}>
                Close instructions
              </Button>
            </div>
          ) : null}
          {status.profiles.length === 0 ? (
            <p className={styles.description}>
              No ChatGPT account connected yet.
            </p>
          ) : null}
          {status.profiles.map(profile => (
            <ProfileRow
              key={`${profile.id}:${profile.defaultModel}`}
              profile={profile}
              busy={busy}
              onAction={(action, model) => {
                run(action, profile, model).catch(error =>
                  setError(error.message)
                );
              }}
              onReconnect={() => setLoginProfile(profile)}
            />
          ))}
        </>
      )}
      <p className={styles.description}>
        Image generation, transcription, embeddings and reranking use separately
        configured providers. ChatGPT request failures never automatically
        switch to another billing source.
      </p>
    </section>
  );
}

function ProfileRow({
  profile,
  busy,
  onAction,
  onReconnect,
}: {
  profile: Profile;
  busy: boolean;
  onAction: (action: string, model?: string) => void;
  onReconnect: () => void;
}) {
  const [model, setModel] = useState(profile.defaultModel ?? '');
  return (
    <div className={styles.profile}>
      <div className={styles.row}>
        <strong>{profile.email || 'ChatGPT account'}</strong>
        <span>{profile.id.slice(0, 8)}</span>
        <span>
          {profile.active ? 'Selected · ' : ''}
          {profile.status.replaceAll('_', ' ')}
        </span>
      </div>
      {profile.status === 'connected' ? (
        <div className={styles.row}>
          <select
            className={styles.selector}
            aria-label={`Model for ${profile.email || profile.id}`}
            value={model}
            disabled={busy}
            onChange={event => setModel(event.target.value)}
          >
            <option value="">Choose a model</option>
            {profile.models.map(model => (
              <option key={model.slug} value={model.slug}>
                {model.displayName}
              </option>
            ))}
          </select>
          <Button disabled={busy} onClick={onReconnect}>
            Reconnect
          </Button>
          <Button disabled={busy} onClick={() => onAction('refreshModels')}>
            Refresh models
          </Button>
          <Button
            disabled={busy || !model}
            onClick={() => onAction('select', model)}
          >
            Use ChatGPT plan
          </Button>
        </div>
      ) : (
        <Button disabled={busy} onClick={onReconnect}>
          {profile.status === 'consent_required'
            ? 'Enable plan usage'
            : 'Reconnect'}
        </Button>
      )}
      <div className={styles.row}>
        <Button disabled={busy} onClick={() => onAction('disconnect')}>
          Disconnect
        </Button>
        {profile.active ? (
          <Button disabled={busy} onClick={() => onAction('disable')}>
            Use other configured providers
          </Button>
        ) : null}
      </div>
    </div>
  );
}
