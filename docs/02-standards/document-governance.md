> 治理版本：2
> 事实状态：current
> 生命周期：active
> 实施状态：n/a
> SSOT 同步：synced
> 对应事实源：docs/README.md, package.json, scripts/check-docs.mjs
> 替代关系：n/a
> 最后复核时间：2026-08-06

# 文档治理规范

本规范参考 [CoFlow 文档治理规范](https://code.byted.org/motor/coflow/blob/master/docs/02-standards/ai-coding/01-doc-governance.md)，按本仓库规模和 npm 工具链裁剪。

## 分层

| 目录 | 角色 |
| --- | --- |
| `docs/README.md` | 总导航和任务路由 |
| `docs/01-architecture/` | 当前架构、边界、运行模型和兼容事实 |
| `docs/02-standards/` | 长期工程与文档规则 |
| `docs/03-workflows/` | 当前操作流程和流程状态 |
| `docs/04-design/` | 未实现或待确认的阶段设计 |
| `docs/05-experience/` | 复盘与可复用经验 |
| `docs/06-archive/` | 已退出当前事实源的历史材料 |
| `docs/07-templates/` | 文档模板 |
| `docs/08-review/` | 仍在进行的专项评审 |
| `docs/09-plan/` | 已确认目标的执行计划 |

根目录不新增业务专题正文。平台约定的 `README.md`、`SECURITY.md`、`CONTRIBUTING.md` 和社区健康文件除外。

## 渐进式披露

默认读取顺序：

1. `docs/README.md`；
2. `docs/01-architecture/project-architecture.md`；
3. 当前任务对应的 standard、workflow、design 或 plan；
4. 只有追溯历史原因时读取 archive。

不得把 design、plan、review 或历史实施日志当作当前系统事实。

## V2 元数据

每份 `docs/**/*.md` 必须在标题前声明：

```text
> 治理版本：2
> 事实状态：current | current-with-known-gaps | target | n/a
> 生命周期：draft | proposed | accepted | active | historical
> 实施状态：not-started | in-progress | completed | n/a
> SSOT 同步：pending | partial | synced | n/a
> 对应事实源：<路径或 n/a>
> 替代关系：<说明或 n/a>
> 最后复核时间：YYYY-MM-DD
```

目录约束：

- Architecture、Workflows：`current`、`current-with-known-gaps` 或 `target`，且生命周期为 `active`；
- Standards：`current + active + n/a`；
- Design：事实状态 `n/a`，生命周期 `draft|proposed|accepted|active`；
- Plan：事实状态 `n/a`，生命周期 `accepted|active`；
- Experience、Review：事实状态 `n/a`，生命周期 `active|historical`；
- Archive：`n/a + historical`，保留原实施结果。

已知缺口写入正文，不创造复合状态。

## 新增、同步与归档

新增前先确定唯一角色，并同步 `docs/README.md` 与所在目录 `README.md`。当前事实只写入 Architecture 或 Workflows；Design 和 Plan 完成后不能继续充当事实源。

物理归档必须在同一变更中完成：

1. 将仍有效事实提取到 current SSOT；
2. 移动原文到 `docs/06-archive/<role>/`；
3. 设置 `生命周期：historical`；
4. 增加 `归档原因`、`原始路径`、`归档时间`；
5. 更新总索引、目录索引和仓库内 Markdown 链接；
6. 运行文档检查。

无法确认事实是否进入 SSOT 时，不得归档。

## 完成标准

文档治理变更必须满足：

- 目录角色和 V2 元数据一致；
- 总索引、目录索引与当前事实同步；
- 旧文档迁移和替代关系可追溯；
- Markdown 相对链接有效；
- `npm run docs:check` 通过；
- 变更报告说明问题、方案、影响、验证和残余风险。

检查器只报告并阻止新增债务，不自动移动文档或修改状态。
