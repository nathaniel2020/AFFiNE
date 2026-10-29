import { Injectable } from '@nestjs/common';

import { BadRequest } from '../../../base';
import { BackendRuntimeProvider } from '../../../core/backend-runtime';

export interface ChatgptProfile {
  id: string;
  email: string;
  active: boolean;
  status: string;
  defaultModel: string | null;
  models: { slug: string; displayName: string; inputModalities: string[] }[];
}

export interface ChatgptStatus {
  enabled: boolean;
  userId: string;
  profiles: ChatgptProfile[];
}

export function chatgptTargetId(profileId: string, model: string) {
  return `chatgpt:${profileId}:${Buffer.from(model).toString('base64url')}`;
}

@Injectable()
export class ChatgptService {
  constructor(private readonly backend: BackendRuntimeProvider) {}

  async status(userId: string): Promise<ChatgptStatus> {
    const status = (await this.backend.chatgptCommand(userId, {
      action: 'status',
    })) as ChatgptStatus;
    // Public HTTP/GraphQL views contain display information only. The CLI accesses
    // registration metadata directly through the runtime for returning sign-ins.
    return {
      enabled: status.enabled,
      userId,
      profiles: status.profiles.map(
        ({ id, email, active, status, defaultModel, models }) => ({
          id,
          email,
          active,
          status,
          defaultModel,
          models,
        })
      ),
    };
  }

  async command(userId: string, command: Record<string, unknown>) {
    try {
      return await this.backend.chatgptCommand(userId, command);
    } catch {
      throw new BadRequest(
        'ChatGPT connection update failed; check the selected connection and try again.'
      );
    }
  }

  async routeOptions(userId: string, routeId: string) {
    const status = await this.status(userId);
    const profiles = status.profiles.filter(p => p.status === 'connected');
    const active = profiles.find(p => p.active);
    return {
      routeId,
      defaultTargetId:
        active?.defaultModel != null
          ? chatgptTargetId(active.id, active.defaultModel)
          : null,
      choices: profiles.flatMap(profile =>
        profile.models.map(model => ({
          id: chatgptTargetId(profile.id, model.slug),
          displayName: `ChatGPT ${model.displayName} · ${profile.email || 'Account'} · ${profile.id.slice(0, 8)}`,
          minimumTier: 'Standard',
          available: true,
        }))
      ),
    };
  }
}
