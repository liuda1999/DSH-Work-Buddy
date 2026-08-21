# LLM Wiki Plugin — Code Wiki 总览与导航

> 项目：`llm-wiki-plugin`（仓库 `praneybehl/llm-wiki-plugin`）· 版本 3.0.0 · MIT 许可 · 作者 Praney Behl
> 源码包：`llm-wiki-plugin-main.zip`（解压于 `e:\claw\llm-wiki-extracted\llm-wiki-plugin-main\`）

## 1. 项目一句话画像

**LLM Wiki 是一个面向 AI 编码代理的"第二大脑"知识库插件**：把 PDF、文章、访谈记录、笔记等来源一次性编译成互相链接的 Markdown Wiki，之后 Agent 可以检索、引用并持续维护这套知识。它实现了 Andrej Karpathy 2026 年 4 月提出的 "LLM Wiki" 模式 —— 与传统 RAG"每次查询重新推导"不同，知识在 ingest 时编译一次、之后持续复利累积。

核心特点（v3.0.0）：

| 特性 | 实现 |
|---|---|
| 默认本地语义检索 | FastEmbed 运行 `BAAI/bge-small-en-v1.5`（设备端），sqlite-vec 存取向量 |
| 混合检索 | BM25 词法排名 + 语义向量排名，RRF（k=60）融合 |
| 增量索引 | 内容哈希（SHA-256）驱动，仅重嵌入新增/变更分节，自动删除失效分节 |
| 零外部服务 | 无 API Key、无远程向量库、查询文本不出本机 |
| 词法逃生舱 | `--no-embed` 纯 Python BM25；本地语义后端故障自动降级 |
| 可选图图层 | 页面 frontmatter 中的类型化 `graph:` 元数据编译为 nodes/edges/SQLite/GraphML |

## 2. 文档地图

| 文档 | 内容 |
|---|---|
| [01-architecture.md](01-architecture.md) | 项目整体架构：三层模型、数据流、运行时拓扑、跨端分发方式 |
| [02-modules.md](02-modules.md) | 主要模块职责：仓库目录级模块清单与分工 |
| [03-skill-scripts.md](03-skill-scripts.md) | 核心工具链：8 个 Python 脚本的关键函数/算法/行号说明 |
| [04-paperclip-plugin.md](04-paperclip-plugin.md) | Paperclip 集成插件：worker 后端、4 个 lib 库、UI 组件、安全模型 |
| [05-commands-workflows.md](05-commands-workflows.md) | 7 个 `/wiki:*` 斜杠命令、SKILL.md 工作流、9 篇 references、7 个模板 |
| [06-data-formats.md](06-data-formats.md) | 数据模型与文件格式：frontmatter 契约、缓存结构、图产物、JSON 输出契约 |
| [07-dependencies.md](07-dependencies.md) | 依赖关系：Python/TypeScript/构建/文档依赖，跨语言字节级对齐机制 |
| [08-running.md](08-running.md) | 项目运行方式：安装、初始化、日常使用、开发构建、测试、CI |
| [09-testing-eval.md](09-testing-eval.md) | 测试与评估体系：检索评估 harness、契约测试、测试语料 |
| [10-audit-report.md](10-audit-report.md) | 文档审计报告（分析完成后单独执行） |

## 3. 快速事实

- **仓库结构**：单仓库多产物 —— Claude 插件（`.claude-plugin/` + `commands/` + `skills/`）、Paperclip 集成（`integrations/paperclip/`）、检索评估（`eval/`）、VitePress 文档站（`docs/`）。
- **语言与规模**：Python（8 个脚本，约 2,870 行，最大的 `wiki_search.py` 840 行）；TypeScript/React（Paperclip 插件约 25 个源文件，`worker.ts` 730 行 + `bm25.ts` 453 行为核心）；Markdown（命令清单、技能参考、模板）。
- **运行环境**：Agent 侧需要 Python ≥3.10 + `uv`；Paperclip 插件需要 Node ≥20 + pnpm；文档站需要 Node ≥20。
- **版本演进**：v0.3.0 引入图图层 → v2.0.x 远程 embedding 供应商模式（含同意/安全加固）→ **v3.0.0（2026-07-20）切换为本地 FastEmbed + sqlite-vec 默认**，Paperclip 伴随插件 v0.5.1。
- **跨语言一致性**：Paperclip TS 实现与 Python `--no-embed` 路径**字节级对齐**（byte-for-byte parity），由快照测试锁定。
- **设计哲学**：Markdown 永远是唯一权威（canonical），所有派生物（解析缓存、向量库、图）随时可删除重建；lint 只报告不修改；typed 边必须有 source + evidence。

## 4. 阅读建议

- 想理解"这个项目是什么"→ 先读 [01-architecture.md](01-architecture.md) 第 1-2 节。
- 想二次开发检索逻辑 → [03-skill-scripts.md](03-skill-scripts.md) 的 `wiki_search.py` 部分。
- 想做平台集成 → [04-paperclip-plugin.md](04-paperclip-plugin.md) 的 manifest 契约与 worker 安全模型。
- 想跑起来 → [08-running.md](08-running.md)。
