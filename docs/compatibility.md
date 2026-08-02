# Compatibility

## 0.1.0

| Component | Tested version |
|---|---|
| QM | `yc-software/qm` revision `7f2c916` |
| Node.js | `24.18.0` |
| `@larksuiteoapi/node-sdk` | `1.72.0` |
| Feishu delivery mode | WebSocket long connection |

The adapter treats QM's source-authenticated HTTP routes as an observed external contract, not a stable upstream SDK. Compatibility CI must run against the exact QM revision above before release. A QM upgrade requires rerunning `npm run test:qm-contract` and the live matrix in `docs/live-test-runbook.md` before updating this table.

Required Feishu capabilities:

- bot enabled;
- `im.message.receive_v1` long-connection event;
- `card.action.trigger` callback;
- `im:message`;
- `im:message:send_as_bot` when principal delivery is enabled;
- `im:resource`;
- `im:chat:readonly` for the connectivity probe.

Known limits:

- one Feishu tenant per process;
- only one principal-delivery consumer may be enabled for a QM deployment;
- image resources are limited to 10 MiB and generic files to 30 MiB;
- delivery and approval metrics are process-local, not QM-global queue metrics;
- no group-history ingestion, reactions, streaming edits, user-token impersonation, cross-tenant chats, or Slack/Feishu identity merging;
- npm publication is intentionally disabled; `0.1.0` is distributed as a container and GitHub release.
