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
  - `im:message` — receive `im.message.receive_v1` events and reply in a message thread.
  - `im:message:send_as_bot` — send proactive messages to a principal `open_id` (only used when `FEISHU_CLAIM_PRINCIPAL_DELIVERIES=1`).
  - `im:resource` — upload and download image/file message resources (30 MB ceiling).
  - `im:chat:readonly` — used only for the startup connectivity probe (`chat.list`).

Use a dedicated non-production tenant and test users for development; never point a development deployment at a production tenant.

## Configuration

Required environment variables:

- `CORE_API_URL`
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
- `GET /readyz` — readiness. Returns `200` only while QM and Feishu connectivity are both confirmed; returns a non-`200` status otherwise so the deployment platform can hold traffic.
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

## License

MIT
