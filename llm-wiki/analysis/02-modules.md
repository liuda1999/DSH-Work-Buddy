# 02 · 主要模块职责

> 路径基准：`llm-wiki-plugin-main/`

## 1. 模块总览

```
llm-wiki-plugin-main/
├── .claude-plugin/          ① Claude 插件清单（plugin.json + marketplace.json）
├── commands/wiki/           ② 7 个 /wiki:* 斜杠命令清单（Claude Code 专属）
├── skills/llm-wiki/         ③ 核心：Agent 技能（SKILL.md + scripts + assets + references）
│   ├── SKILL.md             技能入口与总规范（触发条件/架构/工作流/失败模式）
│   ├── scripts/             8 个 Python 脚本（本项目唯一的"引擎"代码）
│   ├── assets/              7 个 .template 模板（bootstrap 时复制进用户 wiki）
│   └── references/          9 篇深度参考文档（工作流细节的权威来源）
├── integrations/paperclip/  ④ Paperclip 平台集成（人类侧只读伴随插件）
│   ├── plugin/              npm 包 paperclip-plugin-llm-wiki（TS/React 子项目）
│   ├── SPEC.md              v0.1 设计规范（引用 SDK 源码的逐字契约）
│   ├── FEASIBILITY.md       Phase 0 验证报告（SPEC 与 SDK 的勘误记录）
│   └── README.md            运维决策页（装插件 vs 只装技能）
├── eval/retrieval/          ⑤ 检索质量评估 harness（run_eval.py + 契约测试 + 固定语料）
├── docs/                    ⑥ VitePress 文档站（发布到 GitHub Pages）
├── research/                ⑦ 研究笔记（Cerebras 知识库文章，v2 检索架构的参考文献）
├── .github/workflows/       ⑧ CI：deploy-docs.yml + paperclip-plugin.yml
└── 根级文件                  README / CHANGELOG / CONTRIBUTING / LICENSE / package.json（文档站）
```

## 2. 模块职责明细

### ① `.claude-plugin/` — 插件身份

| 文件 | 职责 |
|---|---|
| `plugin.json` | 插件元数据：name `llm-wiki`、version 3.0.0、描述、关键词。Claude Code 安装时读取 |
| `marketplace.json` | 插件市场清单：owner、metadata（v3 描述）、plugins 数组（指向 `./`，含 category `productivity`）。`/plugin marketplace add praneybehl/llm-wiki-plugin` 的入口 |

### ② `commands/wiki/` — 斜杠命令层

7 个 Markdown 清单（init / ingest / query / lint / stats / graph / upgrade），每个含 frontmatter（描述与参数提示）+ 面向 LLM 的分步执行规范。**不含代码** —— 它们编排 ③ 中的脚本与 references。详见 [05-commands-workflows.md](05-commands-workflows.md)。

### ③ `skills/llm-wiki/` — 核心引擎（本项目重心）

| 子模块 | 职责 |
|---|---|
| `SKILL.md` | 技能规范：宽触发面（"add this to my wiki"、"lint the wiki" 等自然语言）、三层三操作词汇表、可扩展性纪律、四大失败模式、8 脚本与 7 模板索引 |
| `scripts/init_wiki.py` | bootstrap/升级 wiki 目录结构 + 模板落盘 + 调用运行时安装（幂等） |
| `scripts/setup_wiki.py` | 强制运行时门禁：装 pinned 依赖、缓存模型、全量同步向量、输出 ready JSON |
| `scripts/wiki_search.py` | 混合检索引擎：解析缓存 → BM25 → FastEmbed 语义 → RRF → JSON 证据 |
| `scripts/wiki_lint.py` | 结构健康检查（10 类发现 + 建页建议，只报告不修改） |
| `scripts/wiki_stats.py` | 规模/形状/链接密度统计 + 分片阈值提示 |
| `scripts/wiki_graph_extract.py` | 图编译器：frontmatter+wikilink → nodes/edges → JSONL/SQLite/GraphML |
| `scripts/wiki_graph_lint.py` | 图元数据校验（15 类发现，对照 ontology.yaml） |
| `scripts/wiki_graph_query.py` | 图查询 CLI：neighbors/edges/path/facts（BFS 最短路） |
| `assets/*.template` | SCHEMA、index、log、page、ontology.yaml、graph README、graph gitignore、cache gitignore 模板 |
| `references/*.md` | architecture / ingest / query / lint / page-conventions / scaling-playbook / agent-memory-integration / retrieval-setup / graph-workflow 九篇权威流程文档 |

函数级说明见 [03-skill-scripts.md](03-skill-scripts.md)。

### ④ `integrations/paperclip/` — 人类侧只读伴随插件

| 组成 | 职责 |
|---|---|
| `plugin/src/manifest.ts` | Paperclip 插件清单：8 项能力声明、4 个 UI 槽位、1 个 `wiki.query` agent 工具、3 项实例配置 |
| `plugin/src/worker.ts` | 后端入口：注册 8 个数据 provider（readPage/searchWiki/loadIndex/lintWiki/wikiHealth/verifySetup/backlinks/relevantForIssue）+ wiki.query 工具；含路径安全模型（realpath 围栏） |
| `plugin/src/lib/` | 4 个与 Python 字节级对齐的纯函数库：bm25 / frontmatter / lint / stats |
| `plugin/src/ui/` | 约 20 个 React 组件：4 个槽位入口 + 页面浏览体系（Reader/FolderTree/Outline/Properties/Backlinks/QuickSwitcher/Topbar）+ SetupView + WikiMarkdown 渲染 |
| `plugin/tests/` | 约 30 个 vitest 规格文件（lib 快照对齐、UI 行为、symlink 安全、manifest 校验） |
| `plugin/scripts/` | prepublish-checks.mjs（类型检查+测试+构建+manifest/tarball 校验）、check-setup-snippets.mjs（文档片段一致性） |
| `SPEC.md` / `FEASIBILITY.md` / `README.md` | 设计规范 / SDK 勘误验证 / 运维决策 |

函数级说明见 [04-paperclip-plugin.md](04-paperclip-plugin.md)。

### ⑤ `eval/retrieval/` — 检索质量评估

| 组成 | 职责 |
|---|---|
| `run_eval.py` | 评估 harness：page/section/hybrid 三模式，recall@5/@10、MRR、负例假阳率；缓存字节不变式；`--gate` 回归门禁 |
| `test_search_contracts.py` / `test_embedding_mode.py` / `test_setup.py` | CLI 契约测试 / 嵌入模式回归（增量、删除、过滤、降级）/ setup 就绪报告回归 |
| `queries.json` | 固定查询集（exact / fuzzy / negative 三类，含期望命中 slug 与可选 filters） |
| `corpus/wiki/` | 固定语料：20 页（7 concepts + 5 entities + 5 sources + 3 synthesis）+ SCHEMA.md，ML 主题 |

详见 [09-testing-eval.md](09-testing-eval.md)。

### ⑥ `docs/` — VitePress 文档站

`docs/.vitepress/config.ts` 定义站点与导航；内容页：index、getting-started、commands、agents、search、graph、workflows、upgrade、integrations；`public/llms.txt` 提供 LLM 友好的站点导出。构建命令见 [08-running.md](08-running.md)。

### ⑦ `research/` — 设计依据

`cerebras-how-we-built-our-knowledge-base.md`：v2 检索架构（分节检索、多检索器融合、证据打包、评估方法）的参考文献笔记。

### ⑧ `.github/workflows/` — CI

| 工作流 | 触发 | 作用 |
|---|---|---|
| `deploy-docs.yml` | push main 且 `docs/**`、`package.json`、`pnpm-lock.yaml` 变更；或手动 | pnpm + Node 20 构建 VitePress → 发布 GitHub Pages |
| `paperclip-plugin.yml` | push/PR 触及 `integrations/paperclip/**`、CHANGELOG、agent-memory-integration.md | 在插件目录跑 `prepublish:check`（typecheck + vitest + esbuild 构建 + manifest/tarball 校验） |

## 3. 模块间依赖方向（代码级）

```
commands/wiki/*.md ──编排──▶ skills/llm-wiki/scripts/*.py ──调用──▶ setup_wiki.py
                                    │                              （uv run --script）
                                    ├── wiki_graph_lint.py 复用 wiki_graph_extract.py 的
                                    │   build_nodes/build_edges（保证 lint 所见 = extract 所出）
                                    └── setup_wiki.py 复用 wiki_search.py 的
                                        collect_pages/collect_sections/向量同步

eval/retrieval/run_eval.py ──子进程调用──▶ wiki_search.py（以 --json 输出为契约）

paperclip plugin（独立 npm 包，不 import Python）
    lib/{bm25,frontmatter,lint,stats}.ts ◀──字节级对齐（快照测试锁定）──▶ 对应 Python 脚本
    worker.ts / ui ──SDK──▶ @paperclipai/plugin-sdk（宿主桥）
```

要点：
- **Python 侧唯一的模块间 import** 是 `wiki_graph_lint.py` → `wiki_graph_extract.py`（L58-60，sys.path 注入同目录）和 `setup_wiki.py` → `wiki_search.py`（L20）。其余脚本完全独立，stdlib 可直接跑。
- **Paperclip 插件与 Python 无运行时耦合**，靠"同一套算法 + 快照测试"保证两个实现对同一 wiki 给出一致结果。
