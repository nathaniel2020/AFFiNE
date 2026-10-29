# Sign in with ChatGPT for personal self-hosted AFFiNE

This branch adds an **optional built-in server provider**, `chatgpt_plan`. It is intended for one person using their own ChatGPT accounts with their own AFFiNE Docker server. It is not a marketplace extension or a shared subscription gateway. The official desktop app remains installed unchanged; account management happens in the self-hosted Web app.

## Implementation

- Enable `copilot.enabled` and `copilot.chatgptEnabled` (default **false**). A persistent `crypto.privateKey`, normally generated in the configuration volume by self-host predeploy, is required. Back up that key with the database.
- `ai_user_chatgpt_profiles` binds each registration to an AFFiNE user. The unique identity is `(user_id, client_id)`, not email. Registration issuer/subject are checked on reconnection. A partial unique database index allows one selected connection per user.
- Tokens are encrypted with a separate HKDF/AES-GCM domain. Authenticated data includes the user, profile, issued client ID, issuer, subject and resource. Browser endpoints never accept tokens or return encrypted credentials or registration metadata.
- `scripts/chatgpt-login.mjs` performs OAuth locally, opens the official browser page and listens only on an ephemeral `127.0.0.1` port. It checks PKCE, state, nonce, signature, issuer, audience, expiry and returning identity. It remembers the issued client ID before exchanging the one-time code. No client secret or API key is used.
- The helper sends one credential record over **stdin** to `docker exec -i`. It saves only public registration metadata and a stable helper host ID under `~/.config/affine-chatgpt/`. The server CLI creates its separate host ID at `~/.affine/config/chatgpt-host-id` before import. Import never replaces that ID. The Docker server owns subsequent refreshes; the helper does not refresh or persist tokens.
- PostgreSQL row locks serialize refresh, reimport and sign-out. Refresh rotation updates credentials, lifetime, scopes and generation atomically. A stale or duplicate import is rejected. Transient refresh errors retain the connection. Invalid grants clear tokens and require reconnection. Sign-out attempts remote revocation and always clears local credentials; an unconfirmed remote result is shown explicitly.
- Model discovery uses the selected account's OAuth token and `GET https://api.openai.com/v1/models`. Only `visibility: list` entries appear. Names and slugs are dynamic. Model-directory updates check the session generation so an old request cannot overwrite a reconnected session.
- ChatGPT is eligible for text and structured slots with an authenticated user. Background embedding jobs have no personal connection. Image/file inputs require declared catalog capabilities or a matching existing AFFiNE model capability entry; unknown models conservatively expose text only.
- The dedicated HTTP adapter fixes the endpoint to `https://api.openai.com/v1/responses`, forces `store:false` and `stream:true`, removes preview-incompatible parameters and carries function tools in `additional_tools`. It replays the full input, raw output items, encrypted reasoning and tool results between rounds. Structured generation consumes SSE internally before the existing decoder validates the result.
- Success requires `response.completed`. Failed/incomplete streams, malformed frames, interrupted streams and cancellation fail the request. A ChatGPT execution has **one candidate**, so it cannot fall back to a different paid source. Explicit BYOK selection still works independently.
- `chatgpt_plan` usage is stored separately and excluded from the AFFiNE AI quota source count. Image generation, transcription, embeddings and reranking still need an explicitly configured existing provider. They are not supplied by the ChatGPT connection.
- A disconnected or invalid selected connection retains its routing selection and fails closed. Choose **Use other configured providers** explicitly to return Auto routing to those providers.

Official contracts checked on 2026-10-29: [registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [self-hosted transfers](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), and [preview limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). Preview contracts can change. Transferred sessions currently have limitations on host-specific attribution/revocation; the server's persisted host ID is kept separate from the laptop's ID.

## Build and isolated acceptance

The development base is canary **0.27.5**. The originally running server and official macOS desktop were **0.27.4**. Treat this as a server upgrade, including all intervening upstream migrations.

Prerequisites: Node **22.12+ in the 22.x line**, Yarn **4.18.0**, Rust from `rust-toolchain.toml`, Docker Buildx, and sufficient memory/disk for a full source build. The Dockerfile pins Node 22.23.2 and uses the repository Rust toolchain. A source build can use tens of GB of temporary storage. The local Docker build defaults to two Rust jobs and disables release LTO to reduce memory pressure on personal Docker hosts; build arguments can override these limits.

```sh
corepack enable
yarn install --immutable
bash scripts/build-chatgpt-image.sh
# Optional local tag or architecture overrides:
# AFFINE_CHATGPT_IMAGE=affine-chatgpt:my-build AFFINE_CHATGPT_PLATFORM=linux/arm64 bash scripts/build-chatgpt-image.sh
```

This builds Web, admin, mobile and the Rust/Node server from this checkout. It loads `affine-chatgpt:local` into the local image store. It does **not** publish, download upstream AFFiNE release artifacts, or change any running instance. `AFFINE_SERVER_NATIVE_SINGLE_ARCH=1` lets the server bundler include only the locally built native binary; normal release builds retain their existing behavior.

Community source builds embed the repository's development license-verification public key (the same key used in `build-test.yml` and debug native builds), because self-hosted startup requires a key even without a Pro license. This does not enable Pro features or validate official commercial licenses. Licensed distributions must supply their appropriate public key via `--build-arg AFFINE_PRO_PUBLIC_KEY` and follow upstream license build requirements. Commercial license compatibility is outside this personal-provider acceptance.

```sh
docker compose -f .docker/selfhost/compose.chatgpt-test.yml up -d
```

This separate project uses **127.0.0.1:13010**, container `affine_siwc_acceptance` and dedicated configuration, storage and PostgreSQL volumes. The migration service and application use the **same image**. Create a test AFFiNE account through its setup page. Do not mount production data into it.

Enable the two Copilot settings in the test server's admin configuration, or merge the following into its existing configuration file and restart only the test application:

```json
{
  "copilot": {
    "enabled": true,
    "chatgptEnabled": true
  }
}
```

Keep the generated configuration-volume private key. Open a server workspace, then **Settings → Integrations → Use your ChatGPT plan**. The card shows the current AFFiNE user ID in the helper command. For the isolated container, add its name:

```sh
node packages/backend/server/scripts/chatgpt-login.mjs \
  --user-id YOUR_AFFINE_USER_ID --container affine_siwc_acceptance
```

Complete the real OAuth consent in the official browser page. Then refresh connections, refresh models, select a model and choose **Use ChatGPT plan**. Reconnection uses the same helper with `--profile-id PROFILE_ID`; a connection missing plan permission also uses `--consent`. Never paste tokens into the Web app, shell arguments, logs, issue reports or Git.

Keep the helper running while authorizing; it waits up to **15 minutes** and prints its current stage. If the browser returns to `127.0.0.1` after the helper has timed out, the callback page cannot connect even though official consent succeeded. Do not refresh that old callback or reuse its code. If the first callback never reached the helper, recover only its public, issued `client_id` with `--client-id oaiapp_YOUR_ISSUED_ID` on the next helper invocation. This saves the registration identifier and starts a new authorization with fresh state, nonce and PKCE. An already imported registration is found by its client ID, or can be selected explicitly with `--profile-id`. The newly issued ID token is still fully verified before import.

For a remote Docker host, create/select a Docker context using SSH, then invoke the same helper locally with `DOCKER_CONTEXT=your-ssh-context`. OAuth stays on the browser's computer and `docker exec -i` transports the record over the context's SSH channel. Do not expose an unauthenticated Docker TCP socket.

Operational CLI (all commands require the AFFiNE user ID):

```sh
docker exec -i -e SERVER_FLAVOR=script affine_siwc_acceptance \
  node ./dist/main.js chatgpt status --user-id YOUR_AFFINE_USER_ID
# Other actions: refreshModels, select --model MODEL, disable, disconnect
# These require --profile-id PROFILE_ID. `import` accepts a JSON record only on stdin.
```

Status deliberately omits tokens. Do not manually reuse an imported record: generations prevent stale imports. If the process ends during handoff, rerun the helper with the saved registration. If import succeeded but its acknowledgement was lost, refresh the Web account list before reconnecting.

## Official desktop compatibility

The existing GraphQL `currentUser.copilot.routeOptions(promptName)` and `routeTargetId` string field are unchanged. ChatGPT choices have a `ChatGPT` name prefix; the opaque target encodes the personal profile and dynamic model slug. The server checks ownership again when resolving it.

Connect official desktop 0.27.4 to the isolated server at `http://localhost:13010`. Reopen its AI conversation after changing connections/defaults to refresh cached choices. The desktop retains its existing model controls; it does not gain this branch's Web login/status components. Verify with the real account:

1. Discover/select a ChatGPT model, chat, summarize, translate and rewrite text.
2. Read/edit a document through AFFiNE tools and run workspace retrieval with a separately configured index provider.
3. Generate mind-map/presentation structures and exercise the existing schema validation.
4. Test an allowed image/file input. Unknown or unsupported model modalities must report unavailable.
5. Disconnect/reconnect, restart only the test container and check connection persistence. Confirm quota/auth/network errors never select a different provider.
6. Exercise explicit BYOK chat, image generation, transcription and indexing with their own configured providers.

A real OAuth session and live model responses are a separate acceptance gate; offline protocol fixtures are not evidence that these live desktop scenarios passed.

## Automated verification

```sh
bash scripts/verify-chatgpt.sh
```

The entry point checks Node/Yarn, runs native unit tests, builds the native binding, runs OAuth helper tests, backend management/desktop-contract tests, Web component tests plus existing BYOK UI tests, TypeScript checks, formatting/lint, server bundling and Compose validation.

For database concurrency tests, provide a **disposable, migrated test database**, never production:

```sh
AFFINE_CHATGPT_TEST_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:PORT/TEST_DB \
  bash scripts/verify-chatgpt.sh
```

The script deploys Prisma migrations to that database and runs the explicit integration tests. Without that variable it reports the database tests as skipped. The feature workflow `.github/workflows/check-chatgpt.yml` runs on pushes to `codex/sign-in-with-chatgpt` and manual dispatch; it includes isolated PostgreSQL and an arm64 image build. It never publishes or deploys an image.

Test coverage includes signed OAuth tokens and bad nonce/issuer/audience/expiry, declined/cancelled callbacks, registration reuse, duplicate imports, identity mismatch, account/user isolation, encrypted data binding, simultaneous refreshes, atomic rotation, transient versus terminal failures, process restart, dynamic routing, streamed structured/attachment payloads, encrypted reasoning/tool replay, limit errors, incomplete streams and cancellation. The management HTTP boundary rejects import or user-ID override fields.

## Upgrade, backup and rollback

Do not upgrade the production instance until isolated acceptance is complete.

1. Record the current image digest, Compose files and configuration. Stop production writes for a consistent backup; dump PostgreSQL with `pg_dump`, and back up the configuration and storage volumes. Store backups outside Git with restricted access. A database backup without its matching private key cannot decrypt connections.
2. Use an immutable local image tag or digest. Apply `.docker/selfhost/compose.chatgpt.override.yml` to the existing deployment's Compose files, setting `AFFINE_CHATGPT_IMAGE` to that image. Inspect `docker compose ... config` before running it. Both `affine` and `affine_migration` must resolve to the same image.
3. Run the migration service once, inspect its exit status and logs, then start the application. Configure/authorize the personal connection on that server; test workspace permissions and AI operations again.
4. To roll back, stop the new application and restore the **matching pre-upgrade database, configuration and storage backups**, then restore the previous image digest/Compose. Merely changing the image does not undo canary database migrations. Never run old and new migration containers concurrently against one database.
5. OAuth refresh rotation can invalidate tokens contained in an older backup. After a rollback, reconnect the ChatGPT registration if required; do not replay old imported token records.

To stop the isolated environment, use `docker compose -f .docker/selfhost/compose.chatgpt-test.yml down`. Its volumes remain for inspection. Remove those dedicated volumes only when the test data is no longer needed.

## Verification record

Local verification on 2026-10-29–30 (Asia/Shanghai), using Node 22.23.2, Yarn 4.18.0 and Rust 1.97.1:

| Check                                                   | Result                                                                                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native library tests                                    | 296 passed, 4 explicitly ignored in the unit run                                                                                                                                      |
| ChatGPT PostgreSQL integration tests                    | Both ignored ChatGPT tests run separately: 2 passed against a disposable pgvector/PostgreSQL 16 container                                                                             |
| OAuth helper tests                                      | 8 passed, including recovery and timeout cleanup                                                                                                                                      |
| Backend management and desktop contract tests           | 3 passed                                                                                                                                                                              |
| Web ChatGPT component and existing BYOK component tests | 12 passed                                                                                                                                                                             |
| TypeScript                                              | Server, frontend core and CLI build checks passed                                                                                                                                     |
| Static checks                                           | Changed JavaScript/TypeScript lint and formatting, Rust formatting, Prisma schema validation and Git whitespace checks passed                                                         |
| Source bundles                                          | Web, admin, mobile, server and native binding built for the arm64 Docker image                                                                                                        |
| Browser component QA                                    | Playwright Chromium at 1100 × 900 and 390 × 844: connection controls, model selection, disconnect/reconnect and instructions; no overflow or console errors                           |
| Isolated Docker startup                                 | arm64 image loaded; schema and data migration service exited 0; `/info` reports self-hosted 0.27.5                                                                                    |
| Real HTTP boundary                                      | Anonymous GET returns 401; authenticated status returns display data; browser token import, user-ID override and unknown connection management return safe 400 responses              |
| Desktop GraphQL compatibility                           | Existing `currentUser.copilot.routeOptions` query succeeds against the running server with the unchanged result shape (empty before OAuth)                                            |
| Container recreation                                    | Test account, enabled configuration and server host ID survive application/migration container recreation with the dedicated volumes                                                  |
| Complete Web settings                                   | A generated demo workspace was synced to the isolated test server; Integrations displays the ChatGPT card, reads the real status endpoint and shows the current user's helper command |

Browser component QA used the real component and button library with fixture management responses. The complete built Web app and its settings entry were also checked against the isolated server using a temporary browser profile and a generated demo workspace. The Browser plugin was not available, so an isolated Playwright browser was used. These checks do not establish live OAuth or official-desktop compatibility.

The locally tested image is `affine-chatgpt:local`, image ID `sha256:ec2417a2143ad166506e48414a42561ded8482206cc9ff430618e15ed883bced`. It was built from the delivery source before the documentation/validation commit, so its OCI revision label has a `-dirty` suffix. Rebuilding from the committed branch produces a label with the final commit. No image was published.

The initial unrestricted release compilation exhausted the 8 GB Docker VM's memory. An existing unrelated container was OOM-killed and restarted, and the running AFFiNE container also restarted during that attempt. No production configuration, image or data was intentionally changed. The build now limits Rust jobs and disables LTO; the bounded arm64 build succeeded. A subsequent isolated startup check caught the required license-public-key setting; the Docker build now embeds the repository development public key and CI additionally boots a server with its migration service.

Real OAuth, live ChatGPT inference, official desktop 0.27.4 end-to-end scenarios, and live checks of other provider credentials remain acceptance gates requiring the user's accounts. No production upgrade is performed by this branch. The feature CI is configured to run after push; local results must not be presented as a completed GitHub Actions run.

The first GitHub Actions run ([40909867365](https://github.com/nathaniel2020/AFFiNE/actions/runs/40909867365)) passed its arm64 image build, packaged runtime check and isolated HTTP/GraphQL smoke test. Its verification job passed all 296 Rust tests but stopped at `cargo fmt` because the runner lacked `rustfmt`. The workflow now explicitly installs that component. The PostgreSQL health probe also specifies the test database and role to avoid misleading authentication messages.
