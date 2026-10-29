import { WorkspaceServerService } from '@affine/core/modules/cloud';
import type { Server } from '@affine/core/modules/cloud/entities/server';
import { ServerDeploymentType } from '@affine/graphql';
import { useLiveData, useService } from '@toeverything/infra';

import { ChatgptConnectionPanel } from './panel';

export function ChatgptSetting() {
  const service = useService(WorkspaceServerService);
  const server = useLiveData(service.server$);
  return server ? (
    <ServerConnection key={server.baseUrl} server={server} />
  ) : null;
}

function ServerConnection({ server }: { server: Server }) {
  const config = useLiveData(server.config$);
  if (config?.type !== ServerDeploymentType.Selfhosted) return null;
  return <ChatgptConnectionPanel fetcher={server.fetch} />;
}
