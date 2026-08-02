# Security Policy

Report source-authentication bypasses, callback forgery, identity confusion, tenant-isolation failures, or secret disclosure privately through GitHub Security Advisories for this repository. Do not open a public issue containing credentials, tenant identifiers, event payloads, commands, or message contents.

Supported releases and their QM compatibility envelope are listed in `docs/compatibility.md`. Security fixes target the latest supported release.

## Trust boundaries

### QM source authentication

Every request to QM is signed with `CORE_SIGNING_SECRET` (HMAC-SHA256 over method, path, timestamp, and body) and carries a fresh timestamp; QM independently verifies the signature and rejects stale or unsigned requests. The signing secret is never logged, never sent to Feishu, and is the only credential that authorizes this adapter to act against QM.

### Callback authenticity

`card.action.trigger` callbacks are never trusted for identity or authority. Card payloads bind only a request ID and an action; the adapter always reloads the current approval from QM and compares the verified callback's `operator.open_id` against `record.request.actor.externalId`. A missing originating request, a missing actor, or a mismatch always denies the action and returns a cannot-verify-requester toast — the callback is never authorized from its embedded value or from adapter-local state.

### Tenant and source isolation

The adapter is configured for exactly one Feishu tenant (`FEISHU_APP_ID`/`FEISHU_APP_SECRET`) and rejects events or callbacks it cannot attribute to that tenant's sender identity. It never imports, vendors, or bundles QM source; the container image ships only its own compiled `dist/` output and production dependencies.

### Content redaction

Default logs carry correlation identifiers, thread/delivery/approval references, and outcome classes — never message bodies, commands, file contents, tenant identifiers, or credentials. The `/healthz` and `/readyz` endpoints return only process/dependency status, never secrets or tenant data.
