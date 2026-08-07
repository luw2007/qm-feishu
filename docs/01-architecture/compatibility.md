> 治理版本：2
> 事实状态：current-with-known-gaps
> 生命周期：active
> 实施状态：n/a
> SSOT 同步：synced
> 对应事实源：package.json, .github/workflows/ci.yml, .github/workflows/release.yml
> 替代关系：n/a
> 最后复核时间：2026-08-06

# Compatibility

## 0.1.0

| Component | Tested version |
|---|---|
| QM | `luw2007/qm` revision `0f0e0ad` |
| Node.js | `24.18.0` |
| `@larksuiteoapi/node-sdk` | `1.72.0` |
| Feishu delivery mode | WebSocket long connection |

The adapter treats QM's source-authenticated HTTP routes as an observed external contract, not a stable upstream SDK. Compatibility CI must run against the exact QM revision above before release. A QM upgrade requires rerunning `npm run test:qm-contract` and the live matrix in `docs/03-workflows/release-verification.md` before updating this table.

Automated compatibility covers health, blob upload/read, asynchronous turn submission and terminal replay, run lookup, empty active-run lookup, empty approval lookup, delivery claim, idempotent delivery acknowledgement routes, and Feishu surface-cache ingestion. Run signal, present approval records, delivery payload decoding with real queued output, and file-artifact reads require deterministic upstream state that the external contract harness cannot create; those paths remain covered by local decoder/unit tests and the live matrix rather than synthetic green integration cases.

Required Feishu capabilities:

- bot enabled;
- `im.message.receive_v1` long-connection event;
- `card.action.trigger` callback;
- `im:message`;
- `im:message.p2p_msg:readonly` for direct-message events;
- `im:message.group_at_msg:readonly` for group mention events;
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
