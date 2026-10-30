export type Json = Record<string, any>;
export type Model = {
  slug: string;
  displayName: string;
  inputModalities: string[];
};
export type Profile = {
  id: string;
  clientId: string;
  issuer: string;
  subject: string;
  email: string;
  generation: number;
  epoch: string;
  status: 'connected' | 'consent_required' | 'reauth_required' | 'signed_out';
  expiresAt: number;
  scopes: string[];
  tokens?: { access: string; refresh: string; identity: string };
  models: Model[];
  verified: Record<string, string[]>;
};
export type State = {
  version: 1;
  hostId: string;
  enabled: boolean;
  profiles: Profile[];
  selected?: { profileId: string; model: string };
  accessKey?: string;
};
export type Session = {
  profileId: string;
  epoch: string;
  model: string;
  accessToken: string;
  scope: string;
};
