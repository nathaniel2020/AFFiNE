#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export BUILD_TYPE=canary PUBLIC_PATH=/
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"
node .yarn/releases/yarn-4.18.0.cjs affine @affine/web build
node .yarn/releases/yarn-4.18.0.cjs affine @affine/admin build
test -s packages/frontend/apps/web/dist/selfhost.html
test -s packages/frontend/admin/dist/selfhost.html
docker build -f .docker/selfhost/Dockerfile.ai-extension-web \
  --build-arg "AFFINE_BASE_IMAGE=${AFFINE_BASE_IMAGE:-affine-chatgpt:local}" \
  -t "${AFFINE_WEB_IMAGE:-affine-chatgpt:gateway-web}" .
printf 'Built optional Web/admin image. No running AFFiNE container was changed.\n'
