# Surface adapter implementation notes

- The adapter targets Node 24.18.0 locally because the workstation default Node 22 cannot satisfy the approved Node 24 engine gate.
- Shared ports use Web `ReadableStream<Uint8Array>` so surface modules remain independent of Node and vendor SDK stream types.
- Threshold defaults remain configuration fields; the 30 MB Feishu upload ceiling is a protocol limit, not an operator tuning threshold.
- The public package exports one runtime value, `startFeishuSurface`; all other public exports are TypeScript types.
- Health starts before external dependency probes: invalid configuration still fails fast, while valid processes remain live with readiness false and retry QM/Feishu connectivity.
- Runtime recovery reuses `FEISHU_DELIVERY_POLL_MS`; the removed `CORE_RETRY_COUNT` field had no consumer and would have advertised behavior the adapter did not implement.
- Approval callback continuity uses QM's persisted `PendingApprovalRecord.request`; the adapter decodes only actor, surface, delivery target, and conversation coordinates, so restart recovery needs no local state and does not expose the original message text.
- Feishu business code `99991400` is retryable even with HTTP 200/400; the pinned SDK documents it as application frequency limiting. Other nonzero business codes remain permanent unless separately documented.
- Compatibility and release CI start `yc-software/qm@7f2c916` with memory stores and run the source-auth contract without the local opt-in skip.
- Approval records in QM `7f2c916` have no status field: HTTP 200 means the record remains pending, while allow/deny deletes it and subsequent lookup returns 404. `decodeApproval` therefore maps a present wire record to `pending`; parsing a resolved status would invent an unsupported contract.
- Local release-candidate smoke used the built `dist/main.js` against pinned QM: liveness stayed 200 while synthetic Feishu credentials kept readiness at 503, metrics remained identifier-free, missing configuration failed closed, and direct Node SIGTERM exited cleanly within the configured deadline.
- Container build/inspection, dedicated-tenant live smoke, CI URLs, immutable image digest, and `v0.1.0` publication remain release gates. This workstation has no container runtime, Feishu credentials, Git remote, or authenticated GitHub session, so the live runbook remains intentionally pending rather than recording synthetic evidence.
