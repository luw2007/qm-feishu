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
7. Test incoming image and file messages only in the bot direct chat. Send each attachment as a standalone message without text or a mention. Feishu does not permit a mention on an attachment message; group attachments are outside the first-release intake contract.

## Smoke matrix

Record only a timestamp and the last six characters of a synthetic message/event ID.

| Scenario | Expected result | UTC | Redacted ID | Pass |
|---|---|---|---|---|
| Direct text message | One QM turn, one acknowledgement, one final reply | 2026-08-03T12:25:46Z | `56294f` | [x] |
| Group mention | Exactly one explicit mention creates one turn | 2026-08-04T13:19:03Z | `2e2c26` | [x] |
| Unmentioned group message | No QM turn and no acknowledgement | 2026-08-04T13:53:07Z | `N/A` | [x] |
| Topic follow-up | Reply remains rooted at the topic root | PENDING | PENDING | [ ] |
| Stop during active run | Active run receives abort; no second run | PENDING | PENDING | [ ] |
| Ordinary follow-up during active run | Follow-up is accepted as steer/turn per QM response | PENDING | PENDING | [ ] |
| Incoming image in bot DM | Standalone image stages a blob with digest and metadata | PENDING | PENDING | [ ] |
| Incoming generic file in bot DM | Standalone file stages a blob with filename/media metadata | PENDING | PENDING | [ ] |
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

On 2026-08-04, QM and the adapter were restarted and remained healthy and ready while bot-authored instructions with redacted message suffixes `0b2ef2`, `2daf64`, `535f69`, and `7d84da` asked the separately accessible synthetic user to perform group checks; none of those instructions is acceptance evidence. User messages `84b026` and `a44a6f` exercised the adapter successfully, but an authoritative Feishu `chat.get` later established that their shared target was `chat_mode: "p2p"`; they are direct-message evidence and cannot satisfy either group row. A dedicated chat with suffix `f1f983` was subsequently created and verified by Feishu `chat.list`, `chat.get`, and member listing as `chat_mode: "group"`, `chat_type: "private"`, with the synthetic user present. Bot-authored instruction `675fd6` reached that group but is not acceptance evidence. At 2026-08-04T13:19:03Z, Feishu identified message `2e2c26` in that group as user-authored with exactly one native bot mention and the expected synthetic nonce; the adapter accepted it, acknowledged both resulting Feishu deliveries without intake, decode, or send failures, and an authoritative source-auth QM replay returned `replayed: true`. This satisfies the group-mention row only; the separate unmentioned-group evidence is recorded below.

At 2026-08-04T13:53:07Z, the synthetic user confirmed sending standalone text `unmentioned-check-20260804` in group `f1f983` without an explicit mention. The adapter intentionally requests only `im:message.group_at_msg:readonly`, not `im:message.group_msg`, so Feishu filtered the unmentioned message before `im.message.receive_v1` and exposed no message ID to the app. During the bounded observation window, no new intake event, acknowledgement, final delivery, or delivery backlog appeared; exact-text searches of the adapter and pinned QM data found no match, and the user observed no response. The matrix records `N/A` rather than inventing an inaccessible message suffix.

The acceptance OAuth probe did not provide a supported user-send path. Its local per-app user token was deleted. Open Platform retained `offline_access` as an OAuth base grant and accepted a deletion draft for the user identity of `im:message` while preserving the tenant/app grant. App version `1.0.6` remains audited but unpublished; direct lifecycle requests were rejected with platform code `10002`, so no remote version transition is claimed.

On 2026-08-05, two real user events that had failed before intake were correlated through separately authorized, read-only user history metadata: suffix `dda1e2` at 2026-08-05T04:28:55Z and suffix `eaa396` at 2026-08-05T04:31:02Z were both `post` messages, not native `file` or `image` messages. Their receive-side bodies used top-level `{ title, content, content_v2 }`, while the adapter accepted only the send-side multilingual `{ post: { <lang>: ... } }` envelope. The decoder now accepts both structures, and a built-artifact synthetic smoke covered mention text plus an embedded image without routing that image through the native attachment downloader. This does not satisfy the incoming image or generic-file rows; both remain unchecked until a real `message_type=image` or `message_type=file` event stages a QM blob.

Feishu attachment messages cannot contain an explicit bot mention. The adapter intentionally keeps the narrow `im:message.group_at_msg:readonly` scope, so a standalone group attachment is not delivered and cannot be safely associated with an earlier mention. Incoming attachment acceptance therefore uses the bot direct chat only: send the image or file as a standalone message with no text and no mention. Corrected DM instruction `537217` was delivered with nonce `qm-feishu-dm-file-1785907611505`; no subsequent real-user file event arrived during the bounded observation window, so both incoming attachment rows remain unchecked.

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
