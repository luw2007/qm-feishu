# qm-feishu

An independently deployable Feishu/Lark message surface for [QM](https://github.com/yc-software/qm). It communicates with QM only through source-authenticated HTTP and never imports or vendors QM source.

## Supported surface

- direct messages and explicitly mentioned group messages
- topic/reply-chain continuity
- active-run stop and ordinary follow-up steering
- durable text and attachment delivery
- proactive principal delivery when explicitly enabled
- requester-verified command approval cards

Non-goals: group history ingestion, reactions, streaming edits, user-token impersonation, cross-tenant chats, and automatic Slack/Feishu identity merging.

## Requirements

- Node.js 24 or newer
- a separately running compatible QM service
- a Feishu application configured for long-connection events

The repositories may be sibling checkouts during development, but they share no workspace, source imports, lockfile, submodule, or symlink.

## Feishu app setup

Create a Feishu/Lark application with these capabilities:

- **Bot** enabled, with the interactive message card feature turned on.
- **Events & Callbacks** delivered over a **long connection** (WebSocket). This adapter never registers a public webhook URL.
- Subscribed event: `im.message.receive_v1` (direct messages and messages in groups where the app is mentioned).
- Card callback: `card.action.trigger`, delivered over the same long connection and answered within 3 seconds.
- Required scopes:
  - `im:message` — reply to messages and manage message resources.
  - `im:message.p2p_msg:readonly` — receive direct-message `im.message.receive_v1` events.
  - `im:message.group_at_msg:readonly` — receive `im.message.receive_v1` events when the app is mentioned in a group.
  - `im:message:send_as_bot` — send proactive messages to a principal `open_id` (only used when `FEISHU_CLAIM_PRINCIPAL_DELIVERIES=1`).
  - `im:resource` — upload and download image/file message resources (30 MB ceiling).
  - `im:chat:readonly` — used only for the startup connectivity probe (`chat.list`).

Use a dedicated non-production tenant and test users for development; never point a development deployment at a production tenant.

### Setup command

Build the adapter, then run the setup command from the repository root:

```sh
npm run build
CORE_API_URL=http://127.0.0.1:18080 \
CORE_SIGNING_SECRET=replace-with-at-least-32-characters \
npm run setup
```

By default, setup opens the official Feishu/Lark device-authorization flow to create an application. It requests only the scopes, event, and callback listed above, then uses the official application v7 API to select WebSocket delivery for both events and callbacks. If the Bot Info response does not contain a tenant key, setup waits for a real `im.message.receive_v1` event; send the bot a test message to prove that long-connection delivery works. Only after credential, bot identity, and tenant verification succeed does setup atomically write the seven required runtime variables to `.env` with mode `0600`.

Setup persists `FEISHU_BRAND=feishu|lark`; runtime uses it for both OpenAPI requests and the long connection. Existing Feishu deployments may omit it because `feishu` is the default. Lark deployments must set it to `lark`.

To configure an existing application, set `FEISHU_APP_ID` and `FEISHU_APP_SECRET`; use `--brand lark` when targeting Lark. Environment variables are the recommended way to pass secrets because command-line arguments may be visible in shell history and process listings. `--env-file <path>` selects another output file. `--no-open-platform-auto` requires an existing App ID and secret, skips all Open Platform mutation, and leaves the scopes, event, callback, and WebSocket mode as an explicit manual prerequisite. Run `npm run setup -- --help` for the complete option list. Secret values are never printed.

## Configuration

Required environment variables:

- `CORE_API_URL` — QM endpoint. Remote endpoints must use HTTPS; plaintext HTTP is accepted only for `localhost`, `127.0.0.0/8`, and `::1`.
- `CORE_SIGNING_SECRET` (at least 32 characters)
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_BOT_OPEN_ID` — the bot identity used for self-message and mention checks.
- `FEISHU_TENANT_KEY` — the only tenant accepted by intake.

Optional environment variables:

- `FEISHU_CLAIM_PRINCIPAL_DELIVERIES=1` declares this adapter to be the deployment's **only** principal-delivery consumer. Do not enable it alongside another principal surface (for example, a Slack adapter also claiming principal deliveries) — QM has no atomic surface arbitration across consumers.
- `HEALTH_HOST` (default `127.0.0.1`; container images set `0.0.0.0`) — bind address for the health server.
- `HEALTH_PORT` (default `3000`) — bind port for the health server.
- `LOG_LEVEL` (default `info`) — one of `debug`, `info`, `warn`, `error`.
- `FEISHU_DELIVERY_CLAIM_MS` (default `30000`), `FEISHU_DELIVERY_POLL_MS` (default `1000`), `FEISHU_APPROVAL_POLL_MS` (default `1000`) — durable-delivery, dependency-recovery, and approval-watcher intervals.
- `CORE_REQUEST_TIMEOUT_MS` (default `10000`) — QM HTTP timeout.
- `FEISHU_SHUTDOWN_TIMEOUT_MS` (default `15000`) — maximum time graceful shutdown waits for in-flight sends to drain.

See `.env.example` for a synthetic local configuration.

## Health, readiness, and shutdown

The runtime exposes two unauthenticated HTTP endpoints on `HEALTH_HOST:HEALTH_PORT`; neither returns secrets or tenant data:

- `GET /healthz` — liveness. Returns `200` once the process has started.
- `GET /readyz` — readiness. Returns `200` only while QM, Feishu OpenAPI, and the Feishu WebSocket long connection are confirmed and delivery polling succeeds; returns a non-`200` status otherwise so the deployment platform can hold traffic.
- `GET /metrics` — process-local JSON counters: claimed-but-unacknowledged delivery backlog, claims, observed lease reclaims, terminal dispositions, and approval-watcher outcomes. These are adapter-process counters, not QM's global queue state.

On `SIGTERM` or `SIGINT`, the process stops accepting new event intake, approval watches, and delivery claims, then waits for active sends to finish, bounded by `FEISHU_SHUTDOWN_TIMEOUT_MS`, before exiting. Deliveries not yet acknowledged before shutdown remain durably claimable in QM after the lease expires.

## Deployment

This adapter runs as an independent process/container next to QM — it shares no workspace, source imports, lockfile, submodule, or symlink with QM, and it reaches QM only through `CORE_API_URL` with requests signed by `CORE_SIGNING_SECRET`.

Build and run the published container image:

```sh
docker build -t qm-feishu .
docker run --rm \
  -e CORE_API_URL=https://qm.internal.example \
  -e CORE_SIGNING_SECRET=... \
  -e FEISHU_APP_ID=... \
  -e FEISHU_APP_SECRET=... \
  -e FEISHU_BOT_OPEN_ID=... \
  -e FEISHU_TENANT_KEY=... \
  -p 3000:3000 \
  qm-feishu
```

The image is a non-root, multi-stage Node 24 build; it contains only `dist/`, production `node_modules`, and `package.json` — no QM source, tests, fixtures, or documentation. `npm start` and the container `CMD` both run `node dist/main.js`. `.github/workflows/container.yml` builds the image and verifies source isolation on every push and pull request; it does not publish images.

## Development

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

The QM contract suite is opt-in:

```sh
QM_CONTRACT_BASE_URL=http://127.0.0.1:18080 \
QM_CONTRACT_SIGNING_SECRET=qm-feishu-contract-secret-00000001 \
npm run test:qm-contract
```

The compatibility envelope is recorded in `package.json` and `docs/compatibility.md`. QM HTTP routes are treated as observed external contracts, not a stable upstream SDK.

## Release

`0.1.0` is container-first; npm publication is intentionally disabled. Complete `docs/live-test-runbook.md`, obtain passing CI and Container runs, and record the immutable image digest before pushing tag `v0.1.0`. The tag-gated Release workflow rejects pending or unchecked evidence, publishes `ghcr.io/luw2007/qm-feishu:0.1.0`, and creates the GitHub release.

## License

MIT
