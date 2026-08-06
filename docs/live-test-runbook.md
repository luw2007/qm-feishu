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
| Topic follow-up | Reply remains rooted at the topic root | 2026-08-06 | `N/A` | WAIVED |
| Stop during active run | Active run receives abort; no second run | 2026-08-05T14:49:03Z | `3ccbdd` | [x] |
| Ordinary follow-up during active run | Follow-up is accepted as steer/turn per QM response | 2026-08-06 | `8e6eac` / `84bbf8` | ACCEPTED LIMITATION |
| Incoming image in bot DM | Standalone image stages a blob with digest and metadata | 2026-08-05T13:33:23Z | `13f1af` | [x] |
| Incoming generic file in bot DM | Standalone file stages a blob with filename/media metadata | 2026-08-05T08:20:41Z | `576d47` | [x] |
| Outgoing file | Upload and idempotent file message precede delivery ack | 2026-08-06T07:53:23Z | `329390` | [x] |
| Allow once | Matching requester continues once with scope `once` | 2026-08-06T03:04:45Z | `723c58` | [x] |
| Deny | Matching requester continues with no approval scope | 2026-08-06T03:26:12Z | `770fcd` | [x] |
| Absent approval request | Callback fails closed; no continuation | 2026-08-05T15:25:50Z | `a96303` | [x] |
| Non-requester approval | Callback fails closed; no continuation | 2026-08-06 | `N/A` | WAIVED |
| Proactive principal delivery | Synthetic principal receives one DM; receipt records DM thread | 2026-08-03T12:42:20Z | `618d4c` | [x] |
| Duplicate event replay | One effective QM turn | PENDING | PENDING | [ ] |
| Transient Feishu send failure | Delivery remains unacked, recovers after lease, UUID remains stable | 2026-08-03T14:27:17Z | `b081b0` | [x] |
| QM unavailable then recovers | Liveness stays `200`; readiness moves `503` to `200` | 2026-08-03T12:34:02Z | `N/A` | [x] |
| SIGTERM during active work | Intake stops and process exits within configured deadline | 2026-08-03T12:34:02Z | `N/A` | [x] |

## Release decisions

For `v0.1.0`, the release owner explicitly waived live verification of a true user topic follow-up and a non-requester approval click on 2026-08-06. These rows are not test passes. The release owner also accepted pinned QM `7f2c916`'s active-run steer limitation: deterministic per-message idempotency preserves replay safety but causes an ordinary follow-up to create a distinct run instead of steering the active run. The adapter does not remove idempotency or inject a non-idempotent signal to conceal that upstream limitation. These three decisions remove only their named live gates from `v0.1.0`; they do not change the implementation or its tested behavior.

## Current environment blockers

Unchecked rows that are not explicitly waived below remain release blockers, not synthetic passes. A real user group mention reached the adapter through Web Messenger on 2026-08-03, but the old build failed before acknowledgement with `QmContractError`; a subsequent authoritative replay of the same idempotency key returned HTTP 200 `{ status: "silent", sessionId }`, exposing and driving a narrow decoder fix. This is not recorded as a passing group-mention smoke. The current workstation's own browsers still redirect to the tenant's conditional-access denial page for device MDM/OS policy, so further user actions must be performed from the separately accessible Web Messenger session. Bot-authored events and direct production-handler injection are not recorded as user-originated live evidence.

On 2026-08-04, QM and the adapter were restarted and remained healthy and ready while bot-authored instructions with redacted message suffixes `0b2ef2`, `2daf64`, `535f69`, and `7d84da` asked the separately accessible synthetic user to perform group checks; none of those instructions is acceptance evidence. User messages `84b026` and `a44a6f` exercised the adapter successfully, but an authoritative Feishu `chat.get` later established that their shared target was `chat_mode: "p2p"`; they are direct-message evidence and cannot satisfy either group row. A dedicated chat with suffix `f1f983` was subsequently created and verified by Feishu `chat.list`, `chat.get`, and member listing as `chat_mode: "group"`, `chat_type: "private"`, with the synthetic user present. Bot-authored instruction `675fd6` reached that group but is not acceptance evidence. At 2026-08-04T13:19:03Z, Feishu identified message `2e2c26` in that group as user-authored with exactly one native bot mention and the expected synthetic nonce; the adapter accepted it, acknowledged both resulting Feishu deliveries without intake, decode, or send failures, and an authoritative source-auth QM replay returned `replayed: true`. This satisfies the group-mention row only; the separate unmentioned-group evidence is recorded below.

At 2026-08-04T13:53:07Z, the synthetic user confirmed sending standalone text `unmentioned-check-20260804` in group `f1f983` without an explicit mention. The adapter intentionally requests only `im:message.group_at_msg:readonly`, not `im:message.group_msg`, so Feishu filtered the unmentioned message before `im.message.receive_v1` and exposed no message ID to the app. During the bounded observation window, no new intake event, acknowledgement, final delivery, or delivery backlog appeared; exact-text searches of the adapter and pinned QM data found no match, and the user observed no response. The matrix records `N/A` rather than inventing an inaccessible message suffix.

The acceptance OAuth probe did not provide a supported user-send path. Its local per-app user token was deleted. Open Platform retained `offline_access` as an OAuth base grant and accepted a deletion draft for the user identity of `im:message` while preserving the tenant/app grant. App version `1.0.6` remains audited but unpublished; direct lifecycle requests were rejected with platform code `10002`, so no remote version transition is claimed.

On 2026-08-05, two real user events that had failed before intake were correlated through separately authorized, read-only user history metadata: suffix `dda1e2` at 2026-08-05T04:28:55Z and suffix `eaa396` at 2026-08-05T04:31:02Z were both `post` messages, not native `file` or `image` messages. Their receive-side bodies used top-level `{ title, content, content_v2 }`, while the adapter accepted only the send-side multilingual `{ post: { <lang>: ... } }` envelope. The decoder now accepts both structures, and a built-artifact synthetic smoke covered mention text plus an embedded image without routing that image through the native attachment downloader. Those events did not satisfy either incoming attachment row; the later native file and image evidence below satisfy both DM attachment rows.

Feishu attachment messages cannot contain an explicit bot mention. The adapter intentionally keeps the narrow `im:message.group_at_msg:readonly` scope, so a standalone group attachment is not delivered and cannot be safely associated with an earlier mention. Incoming attachment acceptance therefore uses the bot direct chat only: send the image or file as a standalone message with no text and no mention. Corrected DM instruction `984e69` was followed by real user file `576d47` at 2026-08-05T08:20:41Z. The adapter received that exact message, completed resource download and QM blob staging before accepting the attachment turn, and reported no decode, intake, acknowledgement, or send failure. QM then emitted a terminal Docker-daemon error from its local sandbox worker; that later execution failure is outside the attachment-transfer contract. Together with the later image evidence, both DM attachment rows pass.

Real user DM image `13f1af` at 2026-08-05T13:33:23Z completed the same attachment-transfer sequence with the 10 MB image bound: the adapter received the exact `message_type=image` ID, downloaded and staged the image before `intake_outcome=accepted`, acknowledged the delivery, and emitted no decode, intake, acknowledgement, or send failure. The user then saw `Got it, working on it.`, followed by the Docker-daemon error and `The run failed.`; the latter two messages are QM worker execution outcomes after attachment acceptance and do not invalidate image transfer.

Live stop acceptance used an isolated in-memory QM process with `BACKGROUND_WORK_ENABLED=false` so a real user turn remained non-terminal without requiring the unavailable Docker sandbox. The real Feishu WebSocket, source-auth HTTP client, intake handler, and Feishu reply path were unchanged. Real user DM seed `b38a28` at 2026-08-05T14:48:54Z created the sole active run and received acknowledgement `189582`; real user text `stop` (`3ccbdd`) arrived in the same DM root/thread at 2026-08-05T14:49:03Z. The adapter reported `intake_outcome=signaled`, QM retained the same active run ID instead of creating a second run, and Feishu recorded bot receipt `58ad4f` with `Stopped.`. The disabled worker stabilized the observation window; it did not replace any surface boundary under test.

Partial topic evidence was recorded at 2026-08-06T04:20:10Z. Real user message `347f40` created a topic in verified private group `f1f983`, carried one native bot mention and thread `8f1a7e`, and was accepted by the adapter. A temporary observer recorded production `reply_in_thread=true` receipt `75733e` for parent `347f40`; an idempotent retry returned the same receipt rather than a duplicate, and application-authenticated `message.get` read it back with root `347f40`, thread `8f1a7e`, chat `f1f983`, and app sender. Because the user message created the topic and therefore had no `root_id`, this does not exercise a user follow-up where `root_id` differs from `message_id`; the release owner explicitly waived that remaining live check for `v0.1.0`.

Live absent-approval rejection passed at 2026-08-05T15:25:50Z using interactive card `a96303` with a synthetic nonexistent request ending `910058`. The real Feishu callback reached the adapter; QM authoritatively returned no approval, every repeated click produced `approval_action_outcome=missing`, and the user saw `This approval request could not be found.` No approval continuation was logged and no active run appeared for the DM thread.

Live allow-once acceptance passed at 2026-08-06T03:04:45Z for interactive card `723c58` and QM approval request `d85f58`. Pinned QM's built-in deterministic mock harness created the authoritative pending approval through a source-authenticated turn without Docker; its stored requester matched the real synthetic Feishu user and granted `once`. The real card callback passed verified-operator checks, reloaded that QM record, submitted the production continuation with scope `once`, and reported `approval_action_outcome=accepted`. QM then returned the approval as missing; a repeated click also returned missing rather than continuing twice.

Live deny acceptance passed at 2026-08-06T03:26:12Z for interactive card `770fcd` and a separate authoritative QM request ending `748399`. The real callback passed requester verification, submitted the production denial continuation with `approved=false` and no approval scope, and reported `approval_action_outcome=denied`. QM then returned the approval as missing, no active run remained, and repeated clicks returned missing rather than submitting another continuation.

Live ordinary-follow-up verification exposed an upstream contract limitation. On an isolated non-terminal QM, real user seed `8e6eac` and follow-up `84bbf8` were both accepted but created distinct runs. A source-auth differential confirmed pinned QM `7f2c916` forks keyed follow-ups (`sameRun=false`, `steered=false`) while unkeyed follow-ups fold (`sameRun=true`, `steered=true`). The adapter must retain its deterministic message idempotency key, and QM's signal route has no idempotency key. The release owner accepted this known limitation for `v0.1.0`; the adapter does not trade replay safety for apparent steering.

Live outgoing-file acceptance passed at 2026-08-06T07:53:23Z. A source-authenticated deterministic QM mock turn ran in the official local Docker sandbox image and wrote one uniquely named file to `$AGENT_OUTBOX`; the run completed, QM produced a Feishu delivery, and the production adapter uploaded and sent a native Feishu `file` message ending `329390`. Application-authenticated read-back confirmed the expected unique filename, `msg_type=file`, and app sender. After the 30-second lease window, adapter metrics reported zero backlog, zero reclaims, and zero terminal dispositions, while an authoritative QM `type=feishu` claim returned no delivery. The official local sandbox image used the complete pinned `fly/Dockerfile` base plus `local/Dockerfile`, carried the expected source fingerprint, and passed QM's cold provision, daemon exec, persistence, warm restart, scratch, and cleanup smoke. Exact-release container publication and immutable image inspection remain separate release gates.

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
