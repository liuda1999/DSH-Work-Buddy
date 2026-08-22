# 08 Python / Native / 工具链 / CI / 测试

## 1. Python SDK（`python/`）

| 部分 | 说明 |
|---|---|
| `python/sdk`（`deepseek-harness-sdk`） | Python 客户端 SDK；`pyproject.toml` 声明源码包 `src/deepseek_harness`，依赖 `deepseek-harness-runtime-bin`（editable 指向 `../sdk-runtime`）；uv.lock 锁定 |
| `python/sdk-runtime`（`deepseek-harness-runtime-bin`） | 钉住的运行时二进制包：`pnpm-workspace.yaml` 注释说明它是"单可执行构建的部署根——纯依赖清单，其闭包即 exe 打包与 Python 运行时分发的内容"；产物含 `dsh-jsonrpc-agent-*` |

要点：

- Python SDK 与 TS SDK 投影**同一个** JSON-RPC 协议（`packages/sdk/protocol`）；agent-loop / 会话生命周期 / `SessionEventMap` 变更必须同 PR 更新两侧预期输出（`pnpm run test` 不覆盖此事）。
- 用户指南：`docs/user/guide/python-sdk.md`。
- 开发文档：`python/development.md`。

## 2. native Landlock 沙箱（`native/landlock-run`）

- 包 `@deepseek-ai/node-addon-landlock-run`（source of record 在 native/，构建产物经 workspace）。
- 功能：Linux Landlock 沙箱启动器——**自限制后 exec**，用于限制未授权命令的文件系统访问。
- API：`launcherPath` / `probe` / `grantArgs`（见 `native/landlock-run/README.md`）。
- 被 `sandbox-local` 在 Linux 上用作 Landlock 后端；Windows 用 `sandbox-windows-acl`，macOS 用 Seatbelt。

## 3. scripts/ — 仓库门禁与生成器

门禁运行器：`scripts/run-gates.ts`（`pnpm run check:all` / `check:ci*` / `doc-sync` 等）——定义 gate 模式、并发策略，汇总失败/跳过决定退出码。

| 类别 | 代表脚本 | 作用 |
|---|---|---|
| 构建/清理 | `clean.ts`、`dev-web.ts` | 清理产物与安全残留；web 开发轮询模式 |
| 图与目录生成 | `gen-module-graph.ts`、`gen-tool-catalog.ts`、`gen-config-catalog.ts`、`gen-cordis-api.ts`、`gen-cordis-catalog.ts`、`gen-client-catalog.ts`、`gen-doc-graphs.ts`、`gen-scoped-events.ts`、`gen-persistence-catalog.ts`、`gen-third-party-notices.ts` | 从源码生成 `docs/module-graph.md`、工具/配置/Cordis API/持久化目录等，全部带 `--check` 新鲜度门禁 |
| 文档校验 | `verify-md-links.ts`、`verify-md-wrap.ts`、`verify-doc-refs.ts`、`verify-doc-budgets.ts`、`doc-typecheck.ts`、`verify-mermaid.ts`、`verify-type-equiv.ts`、`verify-export-jsdoc.ts` | 死链/锚点、一行一段、字数预算、文档内 ts 块可编译、mermaid 可渲染、类型粘贴与源码逐字一致、导出 JSDoc 完整 |
| 包健康 | `run-oxlint.ts`、`publint-all.ts`、`package-invariants.ts`、`verify-runtime-closure.ts`、`verify-node-next-types.ts`、`verify-cordis-config.ts` | Lint、发布入口校验、`./invariant` 契约、运行时闭包、NodeNext 消费者、cordis.yml 完整性 |
| vendor | `rescope-vendor.ts`（`rescope-vendor[:check]`） | vendored 包改名与一致性 |
| 翻译 | `translation-{brief,pairing,prompt}.ts`、`merge-translation-pairing.ts` | 中英双语文档配对工作流（`.i18n.yaml` 侧车 + git merge driver） |
| 发布 | `release/{bump,process,pack,verify,publish,tarball,families}.ts` | 家族化（dsh/vendor）版本推进、打包、验证、发布 |

依赖图数据源：`scripts/package-graph.ts` 扫描 `packages/*/*/package.json` 的 `@deepseek-ai/dsh-*` peerDependencies 并拓扑排序（peerDependencies 是运行时依赖的权威信号）。

## 4. examples/ — 可运行示例

| 示例 | 说明 |
|---|---|
| `examples/acp-agent/` | ACP 自动化 agent（cordis.yml：LLM、sandbox、subprocess、bash、approval 等核心组件），兼作 snapshot 录制载体（`pnpm run demo:acp`） |
| `examples/mcp-memory/` | MCP memory server 接入示例 |
| `examples/web-cordis/` | Web + Cordis 自改运行时示例 |
| `examples/web-schedule/` | Web 定时任务示例 |

`examples/package.json` 作为**单个** workspace 成员声明所有叶子 cordis.yml 插件的并集（`workspace:*`），使任意叶子可用普通 node（`:lib`）从 built `lib/` 引导。另有 `packages/examples/` 内的 demo bundle：`agent-spine-demo`（CLI 脊柱演示）、`acp-demo`、`sdk-jsonrpc-demo`。

## 5. website/ — 文档站

- VitePress（`website/.vitepress/config.ts` + `website/docs.ts`）：把 `docs/` 中选定双语页面投影为站点；`pnpm run docs:build` 兼作死链检查；`verify-doc-site-fragments` 校验投影完整性。

## 6. CI（`.github/workflows/`）

| Workflow | 内容 |
|---|---|
| `ci.yml` | keyless 主 CI：独立 gate 分车道 + Node 22.19/24/26 兼容矩阵（车道内 artifact 消费者等待一次构建） |
| `e2e.yml` | 真 API e2e（`pnpm run test:e2e`，带 worker 上限；无 `DEEPSEEK_API_KEY` 自动跳过） |
| `e2b-e2e.yml` | E2B 沙箱 e2e |
| `release.yml` | 发布流水线（release family bump → verify → pack → verify-packed-install → publish） |
| `sandbox.yml` | 沙箱专项 |

另有 `.gitlab-ci.yml`（GitLab 镜像）与 `scripts/wine-windows-gates.sh`（`check:windows-wine`，仅在诊断已知 Windows 失败时本地使用；CI 拥有该信号）。

## 7. 测试体系

| 层 | 命令 | 说明 |
|---|---|---|
| 单元 | `pnpm run test`（`vitest.config.ts`） | 各包 `tests/*.spec.ts` |
| 覆盖率门禁 | `pnpm run test:coverage` | **CI 覆盖门禁是它而非 `test`**：`packages/*/*/src` 每文件 100% |
| 真 API e2e | `pnpm run test:e2e` | 需要 `DEEPSEEK_API_KEY`，缺 key 自跳过 |
| 快照（keyless） | `pnpm run test:snapshot[:record/:refresh]` | ACP/headless 回放对比预期输出；record 需 key |
| Web 浏览器 | `pnpm run test:web[:refresh]` | 构建后对 built 前端跑 Playwright/浏览器 Vitest |
| Web 性能/压力 | `test:web:perf` / `test:web:stress` | 回放性能 / 压力（DSH_SNAPSHOT=replay） |
| GUI 单元 | `pnpm run test:gui` | packages/client + packages/host |
| 配套 vitest 配置 | 根目录 `vitest.{web,web.perf,web-stress,snapshot,e2e}.config.ts` + `vitest.shared.ts` | |

测试基建包（`packages/test-support/`）：`agent-loop-testkit`（循环测试工具）、`llm-mock-server`（`pnpm run mock:llm`）、`llm-replay`、`acp-snapshot`、`loader-smoke`、`client-test-runtime`。

测试策略要点（`docs/testing.md`）：产品可见行为变更必须在同 PR 带可运行真实示例的 keyless 快照；产品可见插件必须有非单元的 REAL 组合测试（经 Loader 引导 cordis.yml，而非手搭 `ctx.plugin()`）；注册表贡献必须证明 dispose 后移除（HMR 安全）；fixtures 必须在 macOS/Linux 可回放。

## 8. .agents/ — Agent 工作流与决策记录

- `.agents/notes/` — Agent Notes：活跃决策记录（why / 放弃了什么 / 需要什么验证），`implemented/` 描述已发布现实；归档即冻结。非平凡变更必须同 PR 附 Note。
- `.agents/skills/` — 仓库自用 Skills（如 `dsh-pre-push-checks`、`dsh-doc-standards`、`dsh-prose-standard`、`dsh-translate-docs`）。
