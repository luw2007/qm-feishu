> 治理版本：2
> 事实状态：n/a
> 生命周期：historical
> 实施状态：completed
> SSOT 同步：synced
> 对应事实源：docs/01-architecture/project-architecture.md, docs/03-workflows/release-verification.md
> 替代关系：当前事实由架构与发布验证 SSOT 替代
> 最后复核时间：2026-08-06
> 归档原因：设计已实施，不再作为当前事实源
> 原始路径：docs/superpowers/specs/2026-08-04-open-source-release-remediation-design.md
> 归档时间：2026-08-06

# Open-source and release remediation design

## Goal

Make `qm-feishu` safe and reproducible as a public repository, then close the code, contract, packaging, and release-pipeline gaps required for a production-grade `0.1.0` release.

The repository may become public only after the public-source gates pass. The `v0.1.0` tag must remain blocked until every automated gate and the real Feishu live matrix pass on the exact release commit. Missing external evidence must remain visibly pending; synthetic or inferred results cannot replace it.

## Scope

### Included

- Public npm dependency provenance and clean-network reproducibility.
- Project and container license distribution.
- Minimal GitHub community-health files and dependency automation.
- Feishu card callback tenant, application, and operator-tenant validation.
- TLS enforcement for non-loopback QM endpoints.
- WebSocket-aware readiness.
- Approval-watch continuity after an accepted QM turn.
- Removal of unused directory synchronization code.
- Broader pinned-QM HTTP contract coverage.
- One-artifact release verification and publication.
- Immutable GitHub Action and base-image references.
- Automated quality, package, container, dependency, and secret checks.

### Excluded

- Fabricating or pre-completing real Feishu smoke evidence.
- Rotating live credentials without explicit authorization to operate the external Feishu application.
- Adding new product capabilities beyond the currently documented surface.
- Publishing npm package `0.1.0`; the release remains container-first.
- Adding directory synchronization as a new runtime feature.

## Public-source gates

The repository is ready to become public only when all of these conditions hold:

1. Every tracked npm lockfile tarball URL uses the public npm registry or another explicitly documented public upstream.
2. A clean environment without ByteDance network access can execute `npm ci`, typecheck, lint, tests, and build under Node 24.
3. The project license is present in the repository, npm package metadata, npm tarball, and final container image.
4. A full reachable-history secret scan passes on the exact public commit.
5. The ignored local `.env` remains absent from Git, build context, npm tarball, and container image.
6. README, security policy, contribution guidance, code of conduct, issue forms, and pull-request template are discoverable through GitHub's supported locations.

Real local credentials must be rotated by the operator before publication even though the current `.env` is ignored, untracked, and has no observed `.env` path history on reachable refs.

## Security design

### Card callback attribution

`NormalizedCardAction` will preserve:

- callback event ID;
- callback `tenant_key`;
- callback `app_id`;
- operator `open_id`;
- operator `tenant_key`;
- request ID and requested action.

Runtime will reject the callback before querying QM unless:

- callback tenant equals `FEISHU_TENANT_KEY`;
- operator tenant equals `FEISHU_TENANT_KEY`;
- callback app ID equals `FEISHU_APP_ID`.

Missing attribution fields fail closed. Requester authorization remains authoritative in QM: after attribution succeeds, the adapter reloads the approval and requires the stored Feishu requester to equal the verified operator. Card-embedded identity is never trusted.

Tests will cover valid attribution, missing attribution, foreign tenant, operator-tenant mismatch, and foreign app ID. Each negative case must prove no approval lookup and no continuation submission occurs.

### QM transport confidentiality

`CORE_API_URL` will allow:

- `https:` for any valid host;
- `http:` only for loopback hosts used by local development and same-machine deployment: `localhost`, `127.0.0.0/8`, and `::1`.

All other plaintext HTTP targets fail configuration validation before any network port is created. Source-auth HMAC remains unchanged; it provides authenticity and integrity, not confidentiality.

### Supply-chain pinning

- Every third-party GitHub Action will use a reviewed full commit SHA, with the corresponding release version retained in a comment.
- Both Docker stages will use the same Node 24 Alpine image pinned by digest.
- The release pipeline will scan dependencies and the candidate image before publication.
- The release will record the digest of the exact image that passed verification.

## Reliability design

### WebSocket readiness

The production event source will wait for the Feishu SDK `onReady` callback. `eventSource.start()` must not resolve before the long connection is confirmed or rejected. Runtime can set `/readyz` to `200` only after:

1. QM health probe succeeds;
2. Feishu OpenAPI connectivity probe succeeds;
3. Feishu long connection reaches SDK ready state;
4. the first delivery poll completes without error.

A connection error keeps readiness at `503`. Tests will prove that runtime remains unready while the ready callback is pending and transitions only after confirmation.

### Accepted-turn acknowledgement failure

QM acceptance is authoritative. Once `submitTurn` returns a new queued run, failure to send the Feishu acknowledgement must not erase the accepted outcome. The adapter will:

1. attempt the acknowledgement;
2. log only a sanitized failure classification when it fails;
3. still publish the observable surface-cache event best-effort;
4. return the accepted run so runtime starts the approval watcher.

The acknowledgement UUID remains stable, allowing safe manual or event-driven retry without creating a second QM turn.

### Directory synchronization removal

`fetchFeishuDirectory`, `QmPort.pushDirectory`, the corresponding HTTP client route, tests, and exports will be removed because runtime never invokes them and the README does not promise directory synchronization. This narrows the compatibility contract rather than shipping an unowned feature.

## QM HTTP compatibility design

The pinned revision remains `yc-software/qm@7f2c916`. The contract suite will derive its cases from the production `QmPort` after directory removal and cover every route that can be exercised deterministically against an isolated mock-harness QM instance.

Expected coverage includes:

- health;
- blob upload and read;
- async turn submission, run lookup, active-run lookup, and terminal replay;
- abort/steer signal when a deterministic active run can be created;
- delivery claim and acknowledgement, including acknowledgement by idempotency key when a deterministic delivery can be created;
- pending approval and approval lookup when the mock harness can produce an approval;
- file artifact read when a deterministic artifact can be created;
- surface-cache ingest.

A route that cannot be given deterministic preconditions through public QM behavior must not receive a fake green test. It will be listed explicitly in the compatibility document and live runbook with the missing precondition and evidence source. Contract coverage statements must distinguish automated routes from live-only routes.

The pinned revision will have one source of truth consumed by package metadata, workflows, tests, and compatibility documentation, or CI will verify that all duplicated declarations are identical.

## Release artifact design

The release workflow will build the candidate image once and identify it by digest. Downstream verification and publication will consume that same candidate rather than rebuild it.

Required candidate checks:

- non-root runtime user;
- project `LICENSE` present;
- no source, tests, fixtures, docs, environment files, or credentials;
- liveness, unavailable-readiness, and graceful shutdown behavior;
- dependency audit;
- secret scan;
- image vulnerability scan with an explicit high-severity failure policy;
- pinned-QM contract suite;
- completed exact-commit live runbook and independent review verdicts.

The live runbook will no longer require a future release-image digest before the image exists. Instead, the workflow-produced candidate digest becomes release evidence and is included in the GitHub release notes. The release job must publish the already verified digest under the semantic version and commit tags.

## Community surface

Add only the files needed to make contribution boundaries explicit:

- `CONTRIBUTING.md`: supported Node version, setup, focused test commands, security-reporting boundary, PR expectations, and QM compatibility rule.
- `CODE_OF_CONDUCT.md`: Contributor Covenant with a concrete enforcement contact or GitHub reporting path.
- `.github/ISSUE_TEMPLATE/bug_report.yml`: reproduction, versions, redacted logs, and explicit prohibition on secrets or tenant content.
- `.github/ISSUE_TEMPLATE/config.yml`: route security reports to the security policy.
- `.github/pull_request_template.md`: behavior, tests, compatibility, security, and release-evidence checklist.
- `.github/dependabot.yml`: npm and GitHub Actions updates on a bounded schedule.

No changelog is required before the first release; GitHub Releases is the release history source for `0.1.0`.

## Verification

### Test-driven behavior fixes

Before changing production behavior, add and run focused failing tests for:

1. foreign or missing callback attribution;
2. remote plaintext QM URL acceptance;
3. runtime readiness before WebSocket confirmation;
4. acknowledgement failure dropping the accepted outcome and approval watch.

The failure must be caused by the identified behavior, not test setup. After each minimal fix, rerun the same target and then the complete suite.

### Automated gates

Under Node 24:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run build
npm audit --omit=dev
npm pack --dry-run
```

Additional gates:

- verify lockfile registry allowlist;
- run pinned-QM contract suite without skip;
- scan complete reachable Git history for secrets;
- build and inspect the candidate container;
- exercise the candidate container's health, readiness, and shutdown paths;
- obtain independent correctness and security reviews with no unresolved high-severity findings.

### External acceptance

The real Feishu smoke matrix remains a manual external gate. Every row must be exercised using a dedicated non-production tenant and synthetic users. Record only redacted evidence as prescribed by `docs/live-test-runbook.md`. If the current environment cannot perform a scenario, that row remains unchecked and `v0.1.0` remains blocked.

## Completion criteria

The remediation is code-complete when all repository-controlled gates pass and independent reviews have no unresolved blockers. Public-source readiness additionally requires operator confirmation that live local credentials were rotated and the exact public commit passed the full history scan. Production `0.1.0` readiness additionally requires every live matrix row and release evidence field to be complete on the exact candidate commit and digest.
