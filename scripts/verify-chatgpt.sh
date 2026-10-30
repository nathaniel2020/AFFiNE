#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major !== 22 || minor < 12) throw new Error("Node 22.12+ (22.x) required");'
yarn() { node .yarn/releases/yarn-4.18.0.cjs "$@"; }
[[ "$(yarn --version)" == '4.18.0' ]]

# Install with `yarn install --immutable` first. Rust follows rust-toolchain.toml.
env -u DATABASE_URL cargo test -p affine_server_native --lib --locked
cargo fmt --all --check
yarn workspace @affine/server-native build:debug
node --test packages/backend/server/scripts/chatgpt/oauth.test.mjs
yarn affine @affine/server test src/plugins/copilot/chatgpt/chatgpt.spec.ts
yarn vitest run \
  packages/frontend/core/src/desktop/dialogs/setting/workspace-setting/chatgpt/panel.spec.tsx \
  packages/frontend/core/src/desktop/dialogs/setting/workspace-setting/integration/index.spec.tsx \
  packages/frontend/admin/src/modules/settings/ai-config.spec.ts \
  packages/frontend/core/src/desktop/dialogs/setting/workspace-setting/byok/index.spec.tsx
yarn tsc -b packages/backend/server packages/frontend/core tools/cli --pretty false

base="$(git merge-base HEAD "${AFFINE_VERIFY_BASE:-origin/canary}")"
files=()
while IFS= read -r file; do
  [[ -f "$file" ]] && files+=("$file")
done < <({ git diff --name-only "$base" -- '*.ts' '*.tsx' '*.js' '*.mjs'; git ls-files --others --exclude-standard -- '*.ts' '*.tsx' '*.js' '*.mjs'; } | sort -u)
if (( ${#files[@]} )); then
  yarn oxlint --deny-warnings "${files[@]}"
  yarn oxfmt --check "${files[@]}"
fi
git diff --check
if [[ -n "${AFFINE_CHATGPT_TEST_DATABASE_URL:-}" ]]; then
  # Must be a disposable, isolated database. Never set this to production.
  DATABASE_URL="$AFFINE_CHATGPT_TEST_DATABASE_URL" yarn workspace @affine/server prisma migrate deploy
  cargo test -p affine_server_native chatgpt --lib --locked -- --ignored
else
  printf 'Database integration tests skipped: set AFFINE_CHATGPT_TEST_DATABASE_URL to a disposable PostgreSQL database.\n'
fi
AFFINE_SERVER_NATIVE_SINGLE_ARCH=1 yarn workspace @affine/server build
test -s packages/backend/server/dist/main.js
docker compose -f .docker/selfhost/compose.chatgpt-test.yml config --quiet
