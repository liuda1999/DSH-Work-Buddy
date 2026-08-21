# DeepSeek Harness (`dsh`) — Code Wiki

本 Wiki 基于 `deepseek-harness` 仓库源码（版本 `0.1.0-rc.7`，developer preview）分析生成，覆盖项目整体架构、全部模块职责、关键类与函数、依赖关系与运行方式。

仓库源码位置：`e:\deepseek\deepseek-harness\deepseek-harness-master\`（下文所有路径均相对该根目录）。

## 项目一句话

DeepSeek Harness 是 DeepSeek AI 开源的插件化 Agent Harness（`dsh`）：模型适配器、工具注册表、会话日志、Agent 循环本身全部是 Cordis 插件，**一切皆插件、一切可从配置替换**。

## 文档目录

| 页面 | 内容 |
|---|---|
| [01-项目概览](01-项目概览.md) | 项目定位、设计理念、仓库布局、技术栈与规模 |
| [02-整体架构](02-整体架构.md) | 分层架构、Profile/Bundle 组合机制、Turn 流程、事件体系、Session Log、能力缝 (Capability Seam) |
| [03-核心包详解](03-核心包详解.md) | core 组（session / scope / agent / agent-loop / tools / system-prompt）与 llm 组的关键类、方法、事件 |
| [04-能力包详解](04-能力包详解.md) | fs / shell / subprocess / terminal / lsp / skill / mcp / web / sandbox / e2b / code-runtime / subagent / jobs / workflow 等能力缝 |
| [05-会话与数据平面](05-会话与数据平面.md) | session 持久化/投影/标题/遥测、session-query、storage、settings、credentials、attachment、workspace、spill |
| [06-应用与接口层](06-应用与接口层.md) | apps/cli、apps/web、boot、bundle、preset、host、client（Web UI）、api/typert RPC、sdk、acp |
| [07-vendor-Cordis框架](07-vendor-Cordis框架.md) | vendored Cordis 框架：Context / Service / Fiber / 事件系统 / loader 与配套库 |
| [08-Python-Native-工具链](08-Python-Native-工具链.md) | Python SDK、native Landlock 沙箱、scripts 门禁、examples、website、CI、测试体系 |
| [09-依赖关系](09-依赖关系.md) | 依赖规则、分层依赖图、各包依赖清单（源自生成的 module-graph） |
| [10-运行与开发指南](10-运行与开发指南.md) | 环境准备、构建、运行（npm/源码/profile/demos）、测试、Lint/文档门禁、开发约定 |

## 快速上手

```sh
# 方式一：直接从 npm 运行 Web UI（默认 http://127.0.0.1:3080）
npx @deepseek-ai/dsh web

# 方式二：从源码构建运行
pnpm install && pnpm run build && pnpm dsh web

# 一次性 headless 任务（需要 DEEPSEEK_API_KEY）
pnpm dsh --profile headless "summarize this workspace"
```

## 阅读建议

- 想理解"这个项目是什么"：01 → 02
- 想读懂核心循环与数据流：02 → 03 → 05
- 想找某个工具/能力如何实现：04（按能力缝分组）
- 想做二次开发/贡献：09 → 10，并配合仓库内 `AGENTS.md` 与 `docs/`
