#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
image="${AFFINE_CHATGPT_IMAGE:-affine-chatgpt:local}"
platform="${AFFINE_CHATGPT_PLATFORM:-linux/arm64}"
revision="$(git rev-parse HEAD)"
if [[ -n "$(git status --porcelain)" ]]; then revision="${revision}-dirty"; fi
docker buildx build --platform "$platform" --load \
  --file .docker/selfhost/Dockerfile.chatgpt --tag "$image" \
  --build-arg "VCS_REF=$revision" "$@" .
printf 'Built %s (%s). No running container was changed.\n' "$image" "$platform"
