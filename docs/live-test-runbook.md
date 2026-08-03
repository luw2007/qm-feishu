# Live verification runbook

Run only in a dedicated non-production Feishu tenant with synthetic users and a QM instance at the revision in `docs/compatibility.md`. Never paste raw payloads, credentials, tenant identifiers, commands, file contents, or full message IDs into this document or CI logs.

## Release evidence

Do not mark the release complete until every field below is populated with redacted evidence.

- Adapter commit: `PENDING`
- UTC start/end: `PENDING`
- CI run URL: `PENDING`
- QM revision: `7f2c916`
- Node version: `24.18.0`
- Feishu SDK version: `1.72.0`
- Container digest (`sha256:…`): `PENDING`
- Security-review verdict: `PENDING`
- Correctness-review verdict: `PENDING`
- Operator: `PENDING`

## Preconditions

1. Create a dedicated Feishu application and synthetic users.
2. Configure the events, callback, and scopes listed in `docs/compatibility.md`.
3. Start the pinned QM checkout with source authentication and local transfer storage.
4. Export runtime secrets outside the repository. Confirm shell history and command tracing are disabled.
5. Start one adapter instance. Enable `FEISHU_CLAIM_PRINCIPAL_DELIVERIES=1` only after confirming no other principal surface is claiming deliveries.
6. Confirm `GET /healthz` is `200`, `GET /readyz` is `200`, and `/metrics` contains integer counters without identifiers.

## Smoke matrix

Record only a timestamp and the last six characters of a synthetic message/event ID.

| Scenario | Expected result | UTC | Redacted ID | Pass |
|---|---|---|---|---|
| Direct text message | One QM turn, one acknowledgement, one final reply | 2026-08-03T12:25:46Z | `56294f` | [x] |
| Group mention | Exactly one explicit mention creates one turn | 2026-08-03T15:00:14Z | `28ca66` | [ ] |
| Unmentioned group message | No QM turn and no acknowledgement | PENDING | PENDING | [ ] |
| Topic follow-up | Reply remains rooted at the topic root | PENDING | PENDING | [ ] |
| Stop during active run | Active run receives abort; no second run | PENDING | PENDING | [ ] |
| Ordinary follow-up during active run | Follow-up is accepted as steer/turn per QM response | PENDING | PENDING | [ ] |
| Incoming image | Blob staged with digest and metadata | PENDING | PENDING | [ ] |
| Incoming generic file | Blob staged with filename/media metadata | PENDING | PENDING | [ ] |
| Outgoing file | Upload and idempotent file message precede delivery ack | PENDING | PENDING | [ ] |
| Allow once | Matching requester continues once with scope `once` | PENDING | PENDING | [ ] |
| Deny | Matching requester continues with no approval scope | PENDING | PENDING | [ ] |
| Absent approval request | Callback fails closed; no continuation | PENDING | PENDING | [ ] |
| Non-requester approval | Callback fails closed; no continuation | PENDING | PENDING | [ ] |
| Proactive principal delivery | Synthetic principal receives one DM; receipt records DM thread | 2026-08-03T12:42:20Z | `618d4c` | [x] |
| Duplicate event replay | One effective QM turn | PENDING | PENDING | [ ] |
| Transient Feishu send failure | Delivery remains unacked, recovers after lease, UUID remains stable | 2026-08-03T14:27:17Z | `b081b0` | [x] |
| QM unavailable then recovers | Liveness stays `200`; readiness moves `503` to `200` | 2026-08-03T12:34:02Z | `N/A` | [x] |
| SIGTERM during active work | Intake stops and process exits within configured deadline | 2026-08-03T12:34:02Z | `N/A` | [x] |

## Current environment blockers

The unchecked rows remain release blockers, not synthetic passes. A real user group mention reached the adapter through Web Messenger on 2026-08-03, but the old build failed before acknowledgement with `QmContractError`; a subsequent authoritative replay of the same idempotency key returned HTTP 200 `{ status: "silent", sessionId }`, exposing and driving a narrow decoder fix. This is not recorded as a passing group-mention smoke. The current workstation's own browsers still redirect to the tenant's conditional-access denial page for device MDM/OS policy, so further user actions must be performed from the separately accessible Web Messenger session. Bot-authored events and direct production-handler injection are not recorded as user-originated live evidence. Outgoing-file live verification also requires a working QM sandbox; the local backend reported that no Docker daemon was available.

The acceptance OAuth probe did not provide a supported user-send path. Its local per-app user token was deleted. Open Platform retained `offline_access` as an OAuth base grant and accepted a deletion draft for the user identity of `im:message` while preserving the tenant/app grant. App version `1.0.6` remains audited but unpublished; direct lifecycle requests were rejected with platform code `10002`, so no remote version transition is claimed.

## Local and CI gates

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
QM_CONTRACT_BASE_URL=http://127.0.0.1:18080 \
QM_CONTRACT_SIGNING_SECRET="$QM_CONTRACT_SIGNING_SECRET" \
npm run test:qm-contract
```

Required release evidence:

- CI and Container workflows pass on the exact release commit;
- the QM contract test runs without its opt-in skip;
- dependency audit reports no high vulnerabilities;
- secret scan reports no real credentials;
- image inspection contains no source, tests, fixtures, docs, or environment files;
- image runs as non-root and has a recorded immutable digest;
- independent reviews have no unresolved High findings.

## Release and rollback

Push tag `v0.1.0` only after the table and evidence fields are complete. The release workflow publishes `ghcr.io/luw2007/qm-feishu:0.1.0` and creates the GitHub release. Do not publish npm for `0.1.0`.

Rollback by stopping the adapter and withdrawing the GitHub release/container tag. QM core requires no rollback because the adapter is an independent process and owns no QM state.
