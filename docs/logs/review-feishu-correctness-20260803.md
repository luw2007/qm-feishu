# Feishu adapter correctness review (2026-08-03)

Read-only review of `src/feishu/*.ts`, `test/feishu/*.test.ts`, `test/fixtures/feishu/*.json` against
`@larksuiteoapi/node-sdk` **1.72.0** as installed in `node_modules` (types/index.d.ts, lib/index.js).
No files modified.

## Verdict

Message send/reply/patch/upload/download payload shapes and response envelope decoding are byte-for-byte
correct against the installed SDK types, and `FeishuSdkClient` structurally satisfies `FeishuPort`. However,
the WebSocket card-action pipeline is structurally broken end-to-end (button-driven approvals cannot work
over the WS transport as wired), directory pagination silently swallows API errors, and the HTTP-error
taxonomy cannot distinguish transient/rate-limited business errors from permanent ones for the (likely
common) HTTP-200-with-nonzero-`code` error shape. Ranked findings below, most severe first.

---

## 1. [CRITICAL] Card actions never reach the app over the WS transport — confirmed against SDK source, not just types

`src/feishu/events.ts` `FeishuSdkEventSource.start()`:
- creates an `EventDispatcher` and registers only `'im.message.receive_v1'` on it
- creates a `CardActionHandler` (`this.#cardActionHandler`), storing it but **never referencing it again**
- calls `this.#wsClient.start({ eventDispatcher: dispatcher })` — the `CardActionHandler` is not passed

Checked against SDK 1.72.0:
- `WSClient.start(params: { eventDispatcher: EventDispatcher }): Promise<void>` (types/index.d.ts:~317231) —
  the method signature has **no parameter at all** for a card-action handler.
- `WSClient.handleEventData` (lib/index.js:99910) unconditionally does
  `yield this.eventDispatcher.invoke(mergedData, { needCheck: false })` for every inbound WS event frame —
  there is no separate code path that ever calls a `CardActionHandler`.
- `EventDispatcher.invoke` (lib/index.js:98343) looks up `this.handles.get(type)`; if the event's type
  (`'card.action.trigger'` per `AppAddons.callbacks` docs at types/index.d.ts:317432) was never registered,
  it logs `no {type} handle` and returns without invoking anything.
- `CardActionHandler` is the class meant for the HTTP-webhook adapters (`adaptExpress`/`adaptKoa`/`adaptDefault`,
  types/index.d.ts:316906-316925). None of those adapters, nor any HTTP server, appear anywhere in
  `src/feishu/*` or elsewhere in the repo (`grep -rn "adaptExpress\|adaptKoa\|adaptDefault"` outside
  node_modules returns nothing).

Net effect: in the real WS-based deployment, a user clicking an approval card button
(`allow_once`/`allow_session`/`allow_always`/`deny`) produces a `card.action.trigger` frame that
`EventDispatcher.invoke` cannot route anywhere; `handlers.onCardAction` — and therefore
`cards.ts#decodeCardAction`, which is otherwise correctly implemented — is simply never called. The
`cardActionHandler()` getter and the whole `CardActionHandler` construction path are dead code for this
transport.

`test/feishu/events.test.ts` cannot catch this: its "card action handler forwards raw payload" test invokes
the captured `cardHandlerFn` directly (`await cardHandlerFn!({...})`), which only proves the constructor
wiring between `createCardActionHandler`'s second argument and `handlers.onCardAction` — it never simulates
`WSClient → EventDispatcher.invoke` actually delivering a `card.action.trigger` frame, so the missing
dispatcher registration is invisible to the suite.

Fix direction (not applied, read-only review): register `'card.action.trigger'` on the same `EventDispatcher`
that's passed to `wsClient.start()`, forwarding to `handlers.onCardAction`, and drop the unused
`CardActionHandler`/`createCardActionHandler` machinery (or keep it only if a separate HTTP webhook listener
is intentionally planned but not yet wired).

## 2. [HIGH] `fetchFeishuDirectory` never checks the Feishu response `code` — silent truncation instead of fail-fast

`src/feishu/directory.ts` calls `client.im.v1.chat.list(...)` and `client.im.v1.chatMembers.get(...)` and reads
straight from `.data?.items` / `.data?.has_more` / `.data?.page_token`. Per SDK 1.72.0 types, both endpoints
return `{ code?: number; msg?: string; data?: {...} }` — on a business-logic failure `code` is non-zero and
`data` is `undefined`. The current code treats an error response identically to "no more results": the
`for` loop over `data?.items ?? []` just runs zero times and `chatPageToken`/`memberPageToken` become
`undefined`, ending pagination early with whatever was already accumulated (or an empty batch on the first
page). No error ever surfaces.

Every other client method in this package (`probe`, `reply`, `send`, `update` in `client.ts`) explicitly
checks `response.code !== undefined && response.code !== 0` and throws `FeishuPermanentError`. This file is
the one exception, and it is also the one file in `src/feishu/*.ts` with **no corresponding test** —
`test/feishu/` has `cards.test.ts`, `events.test.ts`, `files.test.ts`, `messages.test.ts`, but no
`directory.test.ts` — so this gap is untested as well as unguarded. This directly contradicts the "fail
fast, don't swallow errors" principle applied everywhere else in this package, and a mid-pagination API
error (auth expiry, rate limit, permission revocation) would produce a silently incomplete directory sync
rather than a surfaced failure.

## 3. [MEDIUM] Error taxonomy can't distinguish transient/rate-limited business errors from permanent ones on the common 200+code error shape

`classifyFeishuFailure` in `client.ts` only branches on `error.response.status` (429 → rate-limited,
>=500 → transient, else → permanent) — that's the path taken when axios's default `validateStatus` causes a
non-2xx response to reject. The Lark SDK's default `axios.create()` instance in `lib/index.js` has no
custom `validateStatus`, so this path is only exercised by genuine non-2xx HTTP responses.

But Feishu's IM v1 endpoints (see the reply endpoint's documented "同一用户 5 QPS / 同一群 5 QPS" throttle)
are widely known to return **HTTP 200 with a non-zero business `code`** for exactly this kind of
rate-limiting/business error, not a 429. That shape resolves the axios promise normally and is handled by
the separate, unconditional branch in `reply`/`send`/`update`:
```
if (response.code !== undefined && response.code !== 0) throw new FeishuPermanentError(200, response.code);
```
This always raises `FeishuPermanentError` regardless of what the `code` actually means — there is no
mapping from known Feishu rate-limit/throttle business codes to `FeishuRateLimitedError`/
`FeishuTransientError`. A retry-aware caller upstream (that branches on error class to decide whether to
back off and retry) will treat a transient, retryable throttle response as a permanent failure. This is
flagged as PLAUSIBLE rather than confirmed-in-production since it depends on which HTTP status Feishu
actually returns for these specific endpoints at runtime, but the code as written has no mechanism to handle
the 200+code shape differently no matter what the code is, so the gap exists either way the live behavior
turns out.

## 4. [LOW] `flattenPost` silently drops non-text rich-post elements

`messages.ts#flattenPost` maps each paragraph element to `element.text` and coerces missing values to `''`:
```js
.map((element) => (typeof element.text === 'string' ? element.text : ''))
```
Feishu post (rich text) content can include elements without a `text` field — `at` mentions, `img`, embedded
media/emoji — per the general post-content schema (tag-discriminated elements). Those elements vanish from
the flattened line with no indication anything was omitted (e.g. an `@mention`-only line collapses to an
empty string and is then filtered out entirely by `.filter((line) => line.length > 0)`). This is a
reasonable simplification if the product only cares about visible prose, but it's a real, silent information
loss for rich-post messages that mention people or embed media, worth confirming is in-scope for Step 3
rather than an oversight.

## 5. [LOW] Reply's own `thread_id` is discarded, forcing callers back to the receive path to learn the topic id

`client.ts#reply` always sends `reply_in_thread: true`. Per the SDK's response type for `message.reply`,
the response includes `data.thread_id?: string` — the topic/thread the reply just created or joined.
`messages.ts#decodeMessageReceipt` only extracts `message_id`/`chat_id` into `MessageReceipt`, dropping
`thread_id` entirely, even though `NormalizedFeishuMessage` (the receive-side type) already treats
`threadId` as a first-class field. Any code that needs the topic id right after sending a threaded reply
(e.g. to target further replies at the same topic without waiting for an inbound event) can't get it from
the send path and must wait for/derive it from a subsequent receive event instead.

---

## Confirmed correct (no findings)

- `message.reply` / `message.create` / `message.patch` payload and response shapes match SDK 1.72.0 exactly
  (`data`/`path`/`params` field names, optionality, response `data.message_id`/`chat_id`).
- `image.create` (`image_type: "message"|"avatar"`, 10 MB implied ceiling per SDK docs) and `file.create`
  (`file_type` enum `opus|mp4|pdf|doc|xls|ppt|stream`, 30 MB ceiling per SDK docs) match
  `FEISHU_MAX_IMAGE_UPLOAD_BYTES`/`FEISHU_MAX_FILE_UPLOAD_BYTES`/`feishuFileType` exactly, including the
  boundary-inclusive (`> limit`, not `>=`) rejection semantics.
- `messageResource.get` params/path/response (`getReadableStream`) match `download()`'s usage; `IncomingResource.kind`
  ('image'|'file') is a safe subset of the SDK's unconstrained `type: string`.
- `chatMembers.get` / `chat.list` params, path, and paginated response shape (`items`, `page_token`,
  `has_more`) match `directory.ts`'s type declarations exactly (aside from finding #2's missing `code` check).
  Note `chat.list` is documented as excluding p2p/DM chats ("获取到的群列表中，不包含单聊"), so the directory
  sync's "channels" are group chats only — apparently by design given the naming, not flagged as a bug.
- `im.message.receive_v1` event field names/nesting (`event_id`, `sender.sender_id.open_id`,
  `sender.sender_type`, `message.{message_id,chat_id,chat_type,message_type,content,root_id,thread_id,mentions}`)
  match `decodeReceivedMessage` exactly, and match the exact flattened shape `EventDispatcher`'s
  `RequestHandle.parse` actually delivers (verified by re-implementing `parse()` from lib/index.js and running
  it against the fixtures) — the message-side fixtures are realistic, unlike the card-action fixture (see below).
- `decodeCardAction`'s dual-shape handling (nested `header`/`event` vs. flattened) is not a bug: simulating
  `RequestHandle.parse` against `card-action.json` shows the SDK flattens `header`+`event` onto the top level
  before invoking a card handler, and `decodeCardAction`'s fallback (`raw.event_id` when `raw.header` is
  absent; `body = raw` when `raw.event` is absent) correctly handles that real flattened shape — the
  "schema-2.0 envelope" unit test happens to feed the pre-flatten shape rather than what the SDK would
  actually deliver, but the decode logic is correct either way. The actual blocker is finding #1: this
  correct decoder is simply never reached in the WS transport.
- `FeishuSdkClient` implements every method on `FeishuPort` (`probe`, `reply`, `send`, `update`, `download`,
  `upload`) with matching signatures — structurally satisfies the port with no gaps.
- `WSClient`/`Client` constructor options (`appId`, `appSecret`, `domain`) and `close({force})` match SDK
  1.72.0 exactly.
- UUID propagation: `reply`/`create` always pass `message.uuid` (required, non-optional in `OutgoingMessage`);
  `patch`/`image.create`/`file.create` correctly omit `uuid` since the SDK doesn't accept one there.
