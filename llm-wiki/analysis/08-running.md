# 08 · 项目运行方式

## 1. 用户路径：安装与使用

### 1.1 前提

- 唯一前提：安装 [uv](https://docs.astral.sh/uv/getting-started/installation/)（Python ≥3.10 由其管理）。
- 可选工具：Obsidian（浏览/编辑 wiki，`[[wikilink]]` 与图谱视图天然契合）；Paperclip（人类侧伴随插件）。

### 1.2 Claude Code（全插件）

```
/plugin marketplace add praneybehl/llm-wiki-plugin
/plugin install llm-wiki@llm-wiki
```

安装后插件在任何项目可用 — wiki 住在项目工作目录，不在插件里。

### 1.3 其它 Agent（仅技能）

```bash
npx skills add praneybehl/llm-wiki-plugin -a <agent> -g   # 全局
npx skills add praneybehl/llm-wiki-plugin -a <agent>      # 仅当前项目
```

`--agent` 取值与调用方式（README 表）：

| Agent | --agent | 调用 |
|---|---|---|
| Claude Code | `claude-code` | `/wiki:*` 命令或自然语言 |
| Codex | `codex` | `/skills` 或 `$llm-wiki` |
| Cursor | `cursor` | `/llm-wiki` |
| Gemini CLI | `gemini-cli` | `/skills` 管理命令 |
| OpenCode | `opencode` | 自然语言（原生 skill 工具；也读 `.claude/skills/`） |
| OpenClaw | `openclaw` | 自动暴露为用户命令 |
| Pi / OMP | `pi` / 手动 | `/skill:llm-wiki` / `skill://`（OMP 需 symlink 到 `~/.omp/agent/skills/`；Hermes 到 `~/.hermes/skills/`） |

### 1.4 初始化与日常循环

```
/wiki:init                      # 建结构 + 装运行时；必须看到 "status": "ready"
（把第一个来源放进 raw/）
/wiki:ingest raw/your.pdf       # 编译进 wiki；大文件自动分块
/wiki:query What does my wiki say about X?   # 带引用回答；可回填 synthesis
/wiki:lint                      # 健康检查（每 N 次 ingest 或每周）
/wiki:stats                     # 规模与分片建议
/wiki:graph extract|lint|neighbors|edges|path|facts
/wiki:upgrade                   # 升级既有 wiki（幂等 + SCHEMA 手工合并指引）
```

初始化末尾会提议把 wiki 接线进 agent-memory 文件（CLAUDE.md / AGENTS.md / GEMINI.md）— 需用户批准。

### 1.5 脚本直调（绕过命令）

```bash
# 依赖脚本（uv 按内联元数据建隔离环境）
uv run --script skills/llm-wiki/scripts/wiki_search.py "query" --wiki <project>/wiki --json
uv run --script skills/llm-wiki/scripts/wiki_graph_extract.py wiki/
uv run --script skills/llm-wiki/scripts/wiki_graph_lint.py wiki/

# 无依赖脚本（纯 stdlib）
python skills/llm-wiki/scripts/wiki_search.py "query" --no-embed   # 词法逃生舱
python skills/llm-wiki/scripts/wiki_lint.py wiki/
python skills/llm-wiki/scripts/wiki_stats.py wiki/
python skills/llm-wiki/scripts/wiki_graph_query.py wiki/ neighbors --node product:konvy
```

## 2. 开发者路径

### 2.1 文档站（仓库根）

```bash
pnpm install
pnpm docs:dev   # 本地开发（VitePress）
pnpm docs:build # 产出 docs/.vitepress/dist
pnpm docs:preview
```

### 2.2 Paperclip 插件（`integrations/paperclip/plugin/`）

```bash
pnpm install
pnpm typecheck          # tsc --noEmit
pnpm test               # vitest run（~30 个 spec）
pnpm test:watch
pnpm build              # esbuild → dist/{manifest.js, worker.js, ui/index.mjs}
pnpm build:watch
pnpm prepublish:check   # typecheck + 测试 + 构建 + manifest/tarball 校验（prepublishOnly 钩子）
```

安装到 Paperclip（v0.1 发到 npm 后）：`pnpm paperclipai plugin install paperclip-plugin-llm-wiki`

### 2.3 检索评估（`eval/retrieval/`）

```bash
python3 eval/retrieval/run_eval.py            # 词法报告（page/section 两模式）
uv run --with fastembed==0.8.0 --with sqlite-vec==0.1.9 \
  python eval/retrieval/run_eval.py           # 含 hybrid 模式
python3 eval/retrieval/run_eval.py --gate     # + 回归门禁（CI 用，见 09 文档）

python3 eval/retrieval/test_search_contracts.py
python3 eval/retrieval/test_embedding_mode.py
python3 eval/retrieval/test_setup.py
```

### 2.4 本地端到端冒烟（贡献者指南建议）

CONTRIBUTING.md：提交 PR 前用一个小测试 wiki 跑一遍捆绑脚本验证无回归。

## 3. CI 流水线（`.github/workflows/`）

### 3.1 `deploy-docs.yml`

- 触发：push main 且（`docs/**` | `package.json` | `pnpm-lock.yaml` | 工作流文件自身）变更；或 `workflow_dispatch`
- 权限：contents:read / pages:write / id-token:write；并发组 `pages` 不取消进行中的部署
- 步骤：checkout（fetch-depth 0 供 VitePress 生成 last-updated）→ pnpm（读 packageManager 锁版本）→ Node 20（pnpm 缓存）→ `pnpm install --frozen-lockfile` → configure-pages → `pnpm docs:build` → 上传 artifact → deploy-pages

### 3.2 `paperclip-plugin.yml`

- 触发：push/PR 触及 `integrations/paperclip/**`、`CHANGELOG.md`、`skills/llm-wiki/references/agent-memory-integration.md`、工作流自身
- 默认工作目录 `integrations/paperclip/plugin`
- 步骤：checkout → pnpm → Node 20（按插件 lockfile 缓存）→ `pnpm install --frozen-lockfile` → `pnpm run prepublish:check`

## 4. 运行期产物一览（一次 init + 若干 ingest 后的典型状态）

```
<project>/
├── wiki/
│   ├── SCHEMA.md / index.md / log.md / .page-template.md
│   ├── entities/ concepts/ sources/ synthesis/      ← LLM 维护的页面
│   ├── indexes/                                      ← index>300 行后出现
│   ├── graph/                                        ← ontology.yaml + 编译产物
│   └── .wiki-cache/
│       ├── search-index.json                         ← 解析缓存
│       ├── embeddings.sqlite                         ← 向量索引
│       └── .gitignore
├── raw/ (+ assets/)                                  ← 用户来源（不可变）
├── CLAUDE.md / AGENTS.md / GEMINI.md                 ← 可选：wiki 接线 stanza
└── ~/.cache/llm-wiki/fastembed/                      ← 模型缓存（全局，非项目内）
```

## 5. 故障排查速查

| 症状 | 原因与处置 |
|---|---|
| init 报 "uv is required" | 安装 uv 后重跑（fail-closed 设计，不装运行时不报 ready） |
| 搜索警告 "local semantic search unavailable (…); falling back to lexical" | fastembed/sqlite-vec 缺失或模型失败；用 `uv run --script` 执行，或接受词法降级 |
| setup 报 semantic index is inconsistent | sections 与 vectors 计数不等 — 删 `wiki/.wiki-cache/embeddings.sqlite` 重建 |
| 换模型/维度后行为异常 | `semantic_meta` 不匹配自动 DROP 重建；确认 FASTembed_CACHE_PATH 下模型完整 |
| graph lint 报 Ontology not found | seed `wiki/graph/ontology.yaml`（模板在 assets/） |
| graph query 报 graph.sqlite not found | 先跑 `wiki_graph_extract.py` |
| Paperclip 侧栏空白 | `verifySetup` 数据面检查 wiki 路径解析；确认实例配置 wiki_path 相对公司主 workspace |
