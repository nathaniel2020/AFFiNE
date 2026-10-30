#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node -e 'if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("Use Node 22");'
node .yarn/releases/yarn-4.18.0.cjs workspace @affine/chatgpt-gateway build
docker build -t "${AFFINE_GATEWAY_IMAGE:-affine-chatgpt-gateway:local}" packages/backend/chatgpt-gateway
