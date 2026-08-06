> 治理版本：2
> 事实状态：n/a
> 生命周期：historical
> 实施状态：completed
> SSOT 同步：synced
> 对应事实源：docs/01-architecture/project-architecture.md, docs/03-workflows/release-verification.md
> 替代关系：当前事实由架构与发布验证 SSOT 替代
> 最后复核时间：2026-08-06
> 归档原因：修复计划已完成，不再参与当前执行
> 原始路径：docs/plans/qm-feishu-20260804-open-source-release-remediation.md
> 归档时间：2026-08-06

# qm-feishu open-source release remediation plan

## Accepted requirements

Source: `docs/superpowers/specs/2026-08-04-open-source-release-remediation-design.md`.

- Make dependency installation reproducible from the public npm registry.
- Distribute MIT license metadata and text with every package/container artifact.
- Add the minimum GitHub community-health surface.
- Fail closed on callback tenant/app attribution and non-loopback plaintext QM URLs.
- Make readiness depend on confirmed Feishu WebSocket connectivity.
- Preserve accepted-run processing when the acknowledgement reply fails.
- Remove unused directory synchronization.
- Expand and accurately document pinned-QM contract coverage.
- Verify and publish one container artifact with immutable supply-chain inputs.
- Never fabricate external Feishu smoke or credential-rotation evidence.

## Steps

### Public packaging

1. Regenerate `package-lock.json` against `https://registry.npmjs.org` and add a CI allowlist check.
2. Add package metadata, copy `LICENSE` into the runtime image, and inspect npm/container manifests.
3. Add `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, GitHub issue/PR templates, and Dependabot config.

Verification: public-registry `npm ci`; no `bnpm.byted.org` in tracked lockfile; package dry-run contains LICENSE and no secrets; container workflow requires `/app/LICENSE`.

### Security behavior

1. Add failing tests for missing/foreign callback tenant, operator tenant, and app ID.
2. Preserve attribution fields and reject mismatches before QM access.
3. Add failing tests for remote HTTP QM URLs, then allow HTTP only on loopback.
4. Pin action references and Node image by immutable SHA/digest.

Verification: focused card/runtime/config tests pass; no third-party mutable action tags or unpinned `FROM` lines remain.

### Reliability and cleanup

1. Add a failing runtime test proving readiness remains false before WebSocket ready.
2. Make the production event source wait for SDK readiness.
3. Add a failing intake/runtime test proving acknowledgement failure still returns acceptance and starts approval watching.
4. Preserve the accepted outcome and log only sanitized failure classification.
5. Remove `fetchFeishuDirectory`, `QmPort.pushDirectory`, its client route, tests, and generated public surface.

Verification: focused event/runtime/intake tests pass; no runtime or source references to directory synchronization remain.

### Contract and release

1. Inspect QM `7f2c916` routes and deterministic test preconditions.
2. Extend the live contract suite only for deterministic routes; document live-only gaps.
3. Ensure compatibility revision declarations cannot drift.
4. Refactor release workflow so the tested image artifact is the published artifact, enforce audit/container/secret/image gates, and record the resulting digest after construction.

Verification: pinned-QM suite runs without skip; release workflow has one candidate image flow and cannot publish with pending live evidence.

### Final verification

Under Node 24 run install, typecheck, lint, unit/integration tests, coverage, build, production audit, and package dry-run. Run full reachable-history secret scan. Build and exercise the image if a container runtime is available; otherwise require the exact-commit Container workflow as unresolved evidence. Obtain independent correctness and security reviews and fix all release blockers.

External Feishu smoke rows and live credential rotation remain operator-owned blockers. They are complete only with real redacted evidence.
