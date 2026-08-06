> 治理版本：2
> 事实状态：current-with-known-gaps
> 生命周期：active
> 实施状态：n/a
> SSOT 同步：synced
> 对应事实源：.github/workflows/ci.yml, .github/workflows/container.yml, .github/workflows/release.yml, docs/01-architecture/compatibility.md
> 替代关系：替代 docs/live-test-runbook.md 的当前流程与发布状态
> 最后复核时间：2026-08-06

# Release verification

仅在专用非生产 Feishu tenant、synthetic user 和 [Compatibility](../01-architecture/compatibility.md) 固定的 QM revision 上执行。不得提交原始 payload、credential、tenant identifier、命令、文件内容或完整 message ID。

## Release state

`v0.1.0` 尚未满足发布门禁：

- Adapter commit: `PENDING`
- UTC start/end: `PENDING`
- CI run URL: `PENDING`
- Container digest (`sha256:…`): `PENDING`
- Security-review verdict: `PENDING`
- Correctness-review verdict: `PENDING`
- Operator: `PENDING`

固定环境：QM `7f2c916`、Node `24.18.0`、`@larksuiteoapi/node-sdk` `1.72.0`、Feishu WebSocket long connection。

## Preconditions

1. 创建专用 Feishu 应用和 synthetic users，并配置 compatibility 页面列出的 scopes、event 和 callback。
2. 使用 source authentication 和 local transfer storage 启动固定 QM revision。
3. 在仓库外提供 secrets，并关闭 shell history/command tracing。
4. 只启动一个 adapter；仅在没有其他 principal consumer 时启用 `FEISHU_CLAIM_PRINCIPAL_DELIVERIES=1`。
5. 确认 `/healthz=200`、`/readyz=200`，且 `/metrics` 只含无标识符的整数计数。
6. 输入 image/file 只在 bot 私聊发送；群附件不在支持范围内。

## Live smoke matrix

只记录 UTC 时间和 synthetic message/event ID 后六位。

| Scenario | Expected result | Evidence | Status |
| --- | --- | --- | --- |
| Direct text message | One QM turn, acknowledgement, final reply | `2026-08-03T12:25:46Z / 56294f` | PASS |
| Group mention | Exactly one explicit mention creates one turn | `2026-08-04T13:19:03Z / 2e2c26` | PASS |
| Unmentioned group message | No turn or acknowledgement | `2026-08-04T13:53:07Z / N/A` | PASS |
| Topic follow-up | Reply remains at topic root | `2026-08-06 / N/A` | WAIVED FOR 0.1.0 |
| Stop during active run | Abort active run; no second run | `2026-08-05T14:49:03Z / 3ccbdd` | PASS |
| Ordinary active-run follow-up | Preserve deterministic replay safety | `2026-08-06 / 8e6eac, 84bbf8` | ACCEPTED QM LIMITATION |
| Incoming image in bot DM | Stage bounded blob with metadata | `2026-08-05T13:33:23Z / 13f1af` | PASS |
| Incoming generic file in bot DM | Stage blob with filename/media metadata | `2026-08-05T08:20:41Z / 576d47` | PASS |
| Outgoing file | Upload/send precedes delivery ack | `2026-08-06T07:53:23Z / 329390` | PASS |
| Allow once | Matching requester continues once | `2026-08-06T03:04:45Z / 723c58` | PASS |
| Deny | Matching requester continues without approval scope | `2026-08-06T03:26:12Z / 770fcd` | PASS |
| Absent approval | Fail closed; no continuation | `2026-08-05T15:25:50Z / a96303` | PASS |
| Non-requester approval | Fail closed; no continuation | `2026-08-06 / N/A` | WAIVED FOR 0.1.0 |
| Proactive principal delivery | One DM and resolved DM thread receipt | `2026-08-03T12:42:20Z / 618d4c` | PASS |
| Duplicate event replay | One effective QM turn | `2026-08-06 / N/A` | WAIVED FOR 0.1.0 |
| Transient Feishu failure | Remain unacked and recover with stable UUID | `2026-08-03T14:27:17Z / b081b0` | PASS |
| QM unavailable/recovery | Liveness 200; readiness 503 then 200 | `2026-08-03T12:34:02Z / N/A` | PASS |
| SIGTERM during work | Stop intake and exit within deadline | `2026-08-03T12:34:02Z / N/A` | PASS |

WAIVED 不是 PASS。发布 owner 在 2026-08-06 明确接受三个 live waiver，以及固定 QM revision 在 keyed active-run follow-up 上创建独立 run 的限制；adapter 保留 deterministic message idempotency，不用 replay-unsafe signal 掩盖限制。

详细调查过程与逐项证据已归档到 [0.1.0 live verification history](../06-archive/release-evidence/0.1.0-live-verification-20260806.md)。

## Automated gates

```sh
npm ci
npm run docs:check
npm run typecheck
npm run lint
npm test
npm run build
QM_CONTRACT_BASE_URL=http://127.0.0.1:18080 \
QM_CONTRACT_SIGNING_SECRET="$QM_CONTRACT_SIGNING_SECRET" \
npm run test:qm-contract
```

发布还要求：

- CI 和 Container workflows 在 exact commit 通过；
- QM contract test 未 skip；
- production dependency audit 无 high vulnerability；
- secret scan 无真实 credential；
- image 不含 source、test、fixture、docs 或 environment file，且以 non-root 运行；
- independent reviews 无 unresolved High finding；
- release state 不含 `PENDING`。

## Release and rollback

全部门禁完成后才推送 `v0.1.0`。Release workflow 会再次检查本页、测试 fixed QM contract、构建并扫描一次 candidate image，然后发布同一 image digest 和 GitHub Release。

回滚方式是停止 adapter 并撤回 GitHub Release/container tag；adapter 不拥有 QM schema 或持久状态，因此 QM 无需回滚。
