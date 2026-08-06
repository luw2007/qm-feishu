> 治理版本：2
> 事实状态：n/a
> 生命周期：historical
> 实施状态：n/a
> SSOT 同步：synced
> 对应事实源：docs/README.md, docs/01-architecture/, docs/02-standards/, docs/03-workflows/, docs/06-archive/
> 替代关系：n/a
> 最后复核时间：2026-08-06

# 文档治理变更报告（2026-08-06）

## 问题复盘

仓库没有文档总导航和生命周期元数据。设计、计划、实施日志、旧评审与 live runbook 同时承载当前事实；已删除的 directory 能力仍存在于旧设计，已修复缺陷仍以无状态评审结论出现。`live-test-runbook.md` 混合可复用流程、当前发布门禁和长篇调查过程。

## 修复方案

- 建立 Architecture、Standards、Workflows、Experience、Archive 分层和逐级索引。
- 将当前产品边界、模块职责、grammar、安全边界与已知缺口提取到 Architecture SSOT。
- 将兼容性迁入 Architecture，将发布流程与当前状态提取到 Workflow SSOT。
- 将完成的 design、plan、review、implementation notes 和旧 release evidence 原文物理归档，补齐来源、原因和替代关系。
- 增加 V2 元数据与本地 Markdown 链接检查，并接入 CI/Release。

## 影响范围

文档路径和 release workflow 的证据输入路径发生变化；运行时和业务代码未修改。根 README、Security、Contributing 和 PR template 已切换到新 SSOT。

## 验证

- `npm run docs:check`：通过，校验 24 份治理文档和 29 份仓库 Markdown 的元数据、目录角色与本地链接。
- `npm run lint`：通过。
- `npm run typecheck`：通过。
- `npm test`：275 pass、0 fail、1 skip；skip 为未设置 `QM_CONTRACT_BASE_URL` 时按设计跳过的外部固定 QM contract。
- `npm run build`：通过。

本次不启动 QM contract 环境：未改运行时、QM client 或 wire contract；CI/Release 仍使用固定 QM revision 强制运行该 suite。

独立 reviewer 已通过两种子代理入口和 stateless reviewer 入口尝试，均被 workstation 的全局模型配置阻塞（`No model selected` / `modelRoles.slow` 未配置）；未产生审查结论。该环境问题不通过仓库配置规避。

## 残余风险

Archive 保留原文中的过期陈述用于追溯；这些文档由 `事实状态：n/a`、`生命周期：historical` 和目录索引明确排除出当前事实源。外部 URL 不由本地检查器探测，避免认证和网络状态造成非确定性失败。

## 关联证据

- 参考规范：[CoFlow 文档治理规范](https://code.byted.org/motor/coflow/blob/master/docs/02-standards/ai-coding/01-doc-governance.md)
- 当前导航：[`docs/README.md`](../README.md)
- 当前架构：[`docs/01-architecture/project-architecture.md`](../01-architecture/project-architecture.md)
- 发布工作流：[`docs/03-workflows/release-verification.md`](../03-workflows/release-verification.md)
- 归档索引：[`docs/06-archive/README.md`](../06-archive/README.md)
