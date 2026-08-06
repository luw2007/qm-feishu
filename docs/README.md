> 治理版本：2
> 事实状态：current
> 生命周期：active
> 实施状态：n/a
> SSOT 同步：synced
> 对应事实源：README.md, docs/01-architecture/project-architecture.md
> 替代关系：n/a
> 最后复核时间：2026-08-06

# Documentation

本页是仓库文档总导航。默认只读取当前任务需要的层级，不平铺扫描 `docs/`。

## 阅读顺序

1. [项目架构](01-architecture/project-architecture.md)：系统当前真实结构、边界和已知缺口。
2. [文档治理规范](02-standards/document-governance.md)：文档分层、元数据和迁移规则。
3. 当前任务对应的工作流；只有追溯历史决策时才进入 Archive。

## 任务路由

| 需求 | 事实源 |
| --- | --- |
| 系统边界、运行模型、模块职责 | [Architecture](01-architecture/README.md) |
| QM/Node/Feishu 兼容范围 | [Compatibility](01-architecture/compatibility.md) |
| 文档新增、迁移、归档 | [Standards](02-standards/README.md) |
| 发布门禁与实时验证状态 | [Workflows](03-workflows/README.md) |
| 治理复盘与变更报告 | [Experience](05-experience/README.md) |
| 旧设计、计划、评审、实施证据 | [Archive](06-archive/README.md) |

根目录 `README.md` 面向使用者；`SECURITY.md`、`CONTRIBUTING.md` 和社区健康文件遵循各自平台约定，不承载业务架构事实。
