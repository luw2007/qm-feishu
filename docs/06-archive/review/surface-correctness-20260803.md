> 治理版本：2
> 事实状态：n/a
> 生命周期：historical
> 实施状态：n/a
> SSOT 同步：synced
> 对应事实源：docs/01-architecture/project-architecture.md
> 替代关系：缺陷处置状态见当前架构的已知缺口
> 最后复核时间：2026-08-06
> 归档原因：专项评审已结束，已修复发现不再作为当前缺陷清单
> 原始路径：docs/logs/review-surface-correctness-20260803.md
> 归档时间：2026-08-06

# Surface adapter (Steps 4-5) correctness review (2026-08-03)

Read-only review of `src/surface/{threads,intake,keyed-queue,deliveries}.ts` and
`test/surface/*.test.ts` against the approved plan
(`docs/plans/qm-feishu-20260803-surface-adapter.md`, Steps 4-5) and the design doc
(`docs/superpowers/specs/2026-08-03-qm-feishu-design.md`). No files modified.

## Verdict

Grammar parsing, tenant/self/mention gating, stop-vs-turn semantics, ack ordering, cache-failure
handling, the principal-claim flag, per-destination `KeyedQueue` serialization, part UUID
stability, and duplicate-claim guarding are all correctly implemented and covered by tests.
Two confirmed bugs pass the full test suite anyway: `intake.ts` computes the delivery `destination`
from the wrong message id for topic follow-ups (diverges from `threadRef`'s own root resolution),
and `deliveries.ts` never distinguishes `FeishuPermanentError` from transient failures in the send
path even though that error taxonomy already exists in `src/feishu/client.ts` — every send failure
is treated as retryable forever. A third issue is a real TOCTOU race between `poll()` and `stop()`
that the existing shutdown test cannot catch because it pads timing to avoid it. Ranked below, most
severe first.

---

## 1. [HIGH] Delivery send failures are never classified permanent vs. transient — permanently-undeliverable messages retry forever instead of getting a terminal disposition

Step 5 Work items 3 and 10 require classifying permanent vs. transient errors, and treating
"well-formed but permanently unsupported deliveries" (make no further attempt, log terminal
disposition, ack) the same way malformed/shadow targets are handled today.

`src/surface/deliveries.ts#send`:
```js
try {
  for (const [index, part] of parts.entries()) { ... }
} catch (error) {
  this.#log({ event: 'delivery_send_failed', deliveryId: delivery.id, error: String(error) });
  return;   // <-- always leaves the delivery unacknowledged, regardless of error class
}
```
This `catch` is reached for *every* Feishu send error uniformly. `src/feishu/client.ts` already
exports `FeishuPermanentError`/`FeishuTransientError`/`FeishuRateLimitedError` (classified from
HTTP status and business `code`), but `deliveries.ts` imports neither those classes nor
`instanceof`-checks anything — it has no way to tell "bot removed from chat" (permanent) apart from
"ECONNRESET" (transient). Both cases are currently logged identically and left unacknowledged, so
QM's lease expires and the delivery becomes claimable again — a permanently-undeliverable message
is retried indefinitely instead of being terminal-disposed like a malformed target is
(`#dispatch`'s `shadow || !target` branch, lines 109-116, does correctly ack+log-terminal, but
only for pre-send validation failures, never for a `FeishuPermanentError` thrown by the actual
`feishu.send()` call).

Not caught by tests: `deliveries.test.ts`'s two failure tests ("a failed part leaves the delivery
unacknowledged", "a transient Feishu failure leaves the delivery unacknowledged") both throw plain
`new Error(...)`, never a `FeishuPermanentError`, so there is no test asserting a permanent send
failure gets acknowledged with a terminal-disposition log the way malformed targets do.

## 2. [HIGH] `destination` for topic group follow-ups roots at the wrong message id — diverges from `threadRef` and the design's own grammar rule

The design doc states the root-derivation rule generically for *both* identifiers under "Identity
and Target Grammar", not just `threadRef`:
```
threadRef         feishu:chat:<chat_id>:message:<root_message_id>
delivery target   chat:<chat_id>:message:<root_message_id>

- a non-topic group mention uses the trigger message_id as the reply-chain root;
- a topic message uses root_id as its root;
```
`src/surface/intake.ts` correctly resolves `threadRef` via `resolveThreadRef`, which uses
`message.rootId ?? message.messageId`. But `destination` is computed separately, three lines
later, using the raw triggering id unconditionally:
```js
const threadRef = renderThreadRef(resolveThreadRef(message));   // uses rootId ?? messageId
...
const destination = renderDeliveryTarget({
  kind: 'chat',
  chatId: message.chatId,
  rootMessageId: message.messageId,   // <-- always the trigger id, never message.rootId
});
```
For a topic follow-up (`rootId` present and different from `messageId`), `threadRef` correctly
roots at `rootId` while `destination` roots at the follow-up's own `messageId` — the two
identifiers for the same conversation now disagree on "root", contradicting the shared grammar and
risking QM's async reply being posted against the wrong/leaf message rather than the topic root.

Not caught by tests: the only group test with `rootId` set
(`'handleIncomingMessage: returns the queued runId and threadRef for the approval watcher'`,
`test/surface/intake.test.ts:384-400`) asserts only `outcome.threadRef`, never
`qm.calls.submitTurn[0].destination`. No test in the suite ever checks `destination` for a message
where `rootId !== messageId`, so this divergence is invisible to the suite.

## 3. [MEDIUM] `stop()`/`poll()` TOCTOU race can report a bounded, drained shutdown while a claim already in flight still dispatches sends afterward

Step 5 Work item 12 and its verification bullet require shutdown to "stop new claims and await
active sends up to a configured timeout." `FeishuDeliveryDispatcher.stop()` only awaits
`KeyedQueue#drain`, and `KeyedQueue#active` is incremented only inside `#dispatch`, *after*
`claimDeliveries()` has already resolved and (for non-terminal deliveries) `#queue.run(...)` has
been invoked:
```js
async poll(): Promise<void> {
  if (this.#stopped) return;               // checked once, at entry
  ...
  claimed.push(...(await this.#qm.claimDeliveries(type, this.#leaseMs)));  // await window
  await Promise.all(claimed.map((delivery) => this.#dispatch(delivery)));  // #active++ happens here
}
async stop(timeoutMs = this.#shutdownTimeoutMs): Promise<void> {
  this.#stopped = true;
  const drained = await this.#queue.drain(timeoutMs);   // sees #active===0 if no dispatch has run yet
  ...
}
```
If `stop()` runs while a concurrent `poll()` is still awaiting `claimDeliveries()` (or between that
resolving and `#dispatch` registering work in the queue), `#active` is still `0`, so
`KeyedQueue#drain` resolves `true` immediately — `stop()` reports a clean bounded drain — and then
the in-flight `poll()` proceeds to claim and actually send messages *after* the caller believes
shutdown completed. `#stopped` only gates *new* `poll()` invocations checked at entry; it does
nothing for a `poll()` already past that check.

Not caught by tests: `'stop blocks new claims and drains active sends within a bounded timeout'`
(`test/surface/deliveries.test.ts:476-504`) does `await delay(10)` after starting `firstPoll` and
before calling `stop()`, specifically to let `firstPoll` reach `send()` (which blocks on a gate)
before `stop()` runs — i.e. `#active` is already `1` by the time `drain()` is checked, so the test
never exercises the window where a claim is in flight but `#active` is still `0`.

## 4. [MEDIUM, scope caveat] `delivery.attachments` is silently ignored by the send path — a delivery with required attachments would be acknowledged as fully sent after only the text parts succeed

`src/surface/deliveries.ts#send` only ever renders `delivery.text` via `splitDeliveryText`; it
never reads `delivery.attachments` (typed on `Delivery` in `src/types.ts`). If a claimed
`type=feishu`/`type=principal` delivery ever carries attachments before Step 6 lands support for
them, the current code sends only the text, then acknowledges the delivery as fully complete —
silently dropping the attachment content rather than failing closed or terminal-disposing it. This
contradicts the "acknowledge only after every required message part succeeds" principle stated for
Step 5. Flagged as scope-caveat rather than a hard defect since Step 6 ("Bidirectional Attachments")
is explicitly the step that adds attachment handling to this file — but nothing in the current code
guards against QM handing this adapter an attachment delivery in the interim, and no test exercises
`delivery({ attachments: [...] })` to pin down the intended behavior either way.

## 5. [LOW] Two independently-maintained implementations of the same delivery-target grammar

`src/surface/threads.ts` exports `parseDeliveryTarget` (split-based, throws `ThreadGrammarError`
on rejection) and `src/surface/deliveries.ts` defines its own, separate `parseDeliveryTarget`
(regex-based: `CHAT_TARGET`/`USER_TARGET`, returns `undefined` on rejection). Both currently accept
and reject the same set of inputs (confirmed against both test suites' malformed-input lists), but
nothing enforces that agreement going forward — a future grammar change applied to one is easy to
miss in the other, and `deliveries.ts` never imports/reuses `threads.ts`'s already-exported parser.

## 6. [LOW] `splitDeliveryText` chunks by UTF-16 code unit, not by surrogate-pair/grapheme boundary

`splitDeliveryText` (`src/surface/deliveries.ts`) does `text.slice(index, index + maxChars)` over
raw UTF-16 code units. A 4-byte character encoded as a surrogate pair (many emoji, some CJK
extension-B characters) landing exactly on a `maxChars` boundary gets split across two parts,
producing a lone unpaired surrogate at the end of one Feishu message and the start of the next —
likely rendering as a replacement character or invalid text on the Feishu side. Not exercised by
any test (`splitDeliveryText` tests use only single-code-unit ASCII input).

---

## Confirmed correct (no findings)

- `threads.ts` grammar: `renderThreadRef`/`parseThreadRef`/`renderDeliveryTarget`/`parseDeliveryTarget`
  round-trip exactly per the design's grammar, correctly reject unknown prefixes, empty
  identifiers, and extra segments (both directions, both target kinds).
- `resolveThreadRef` correctly implements "non-topic group mention roots at trigger `message_id`;
  topic message roots at `root_id`; DM roots at the p2p chat" — this is the one place the rule is
  applied correctly (see finding #2 for where it's *not* reused).
- Tenant/self/mention gating in `intake.ts`: external tenant (present-but-wrong and
  absent-tenant-key) fails closed, empty/whitespace sender id fails closed, self-messages are
  ignored, unmentioned group messages are ignored, and >1 mention of the bot fails closed as
  ambiguous — all before any QM call, matching Step 4 Work item 11 and the verification matrix.
  "Unsupported encrypted chat" (also required by Work item 11) is handled upstream in
  `src/feishu/messages.ts` (`chat_type !== 'p2p' && !== 'group'` throws `FeishuDecodeError` at
  decode time), so no gap exists even though `intake.ts`/`NormalizedFeishuMessage` has no explicit
  case for it.
- Stop-vs-turn: an explicit `"stop"` text with an active run signals `{ kind: 'abort' }` and returns
  without submitting a second turn; `"stop"` with no active run and ordinary follow-ups both submit
  normally, correctly propagating QM's `steered` flag.
- Ack ordering: `reply()` is only called after `submitTurn()` resolves successfully; a QM `403` is
  correctly treated as terminal `refused` (no ack sent), not rethrown for infrastructure retry.
- Cache failure semantics: `ingestSurfaceEvents` failure is caught and swallowed after the turn is
  already accepted and acknowledged — never rolls back or resubmits the turn.
- Idempotency: inbound turns use `feishu:message:<message_id>` exactly per the design's identifier
  grammar; duplicate `message_id` values reuse the same key deterministically.
- Principal flag: `claimPrincipalDeliveries` defaults to `false`; `poll()` only claims
  `type=principal` when explicitly `true`, matching "principal claims remain off by default."
- Splitting/UUID stability: `splitDeliveryText` produces the same boundaries for the same input on
  every call (no now()/random()); `derivePartUuid` is a deterministic SHA-256 of
  `idempotencyKey\0partIndex\0partKind`, truncated to 50 chars, verified to vary with each input and
  to be stable across two independently constructed dispatchers (retry test).
- Duplicate claims: `#inFlight` (a `Set<deliveryId>`) guards against a second concurrent `poll()`
  tick dispatching the same already-in-flight delivery a second time; verified by test.
- Per-destination queueing: `KeyedQueue.run` correctly chains same-key tasks strictly in order via
  `previous.then(task, task)` (deliberately using the same handler for both branches so a prior
  task's rejection never blocks the next same-key task), while different keys run fully
  independently; `activeCount`/`drain` bookkeeping in the `finally` block is correct in isolation
  (see finding #3 for the composition-level gap with `deliveries.ts`).
- Lost-ack recovery: `#ack` catches `ackDelivery` failure and retries through
  `ackDeliveryByKey(delivery.idempotencyKey)`, matching the "recover via idempotency key" contract.
- Terminal dispositions for malformed/shadow deliveries: verified correct and tested — no Feishu
  call is made, a structured `delivery_terminal` log is emitted, and the delivery is acknowledged
  (contrast with finding #1, which is about *send-time* permanent failures, a different code path).
