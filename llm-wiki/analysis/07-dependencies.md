# 07 · 依赖关系

## 1. Python 侧（Agent 工具链）

### 1.1 运行前提

- **Python ≥ 3.10**（所有 PEP 723 元数据声明 `requires-python = ">=3.10"`）
- **`uv`** — 唯一硬前提（README Installation 节）。带依赖的脚本经 `uv run --script` 执行，uv 按 PEP 723 内联元数据创建隔离环境；init/upgrade 在 uv 缺失时 **fail-closed**（`init_wiki.py` L129-139）

### 1.2 PEP 723 pinned 依赖矩阵

| 脚本 | fastembed | sqlite-vec | pyyaml |
|---|---|---|---|
| `setup_wiki.py`（L2-9） | ==0.8.0 | ==0.1.9 | ==6.0.3 |
| `wiki_search.py`（L2-8） | ==0.8.0 | ==0.1.9 | — |
| `wiki_graph_extract.py`（L2-7） | — | — | ==6.0.3 |
| `wiki_graph_lint.py`（L2-7） | — | — | ==6.0.3 |
| `init_wiki.py` / `wiki_lint.py` / `wiki_stats.py` / `wiki_graph_query.py` | 纯 stdlib（argparse/json/re/sqlite3/hashlib/math/xml.etree/collections/datetime/subprocess/shutil） | | |

语义模型：FastEmbed 加载 `BAAI/bge-small-en-v1.5`（384 维），缓存于 `FASTEMBED_CACHE_PATH`（默认 `~/.cache/llm-wiki/fastembed`）。

### 1.3 脚本间 import 依赖（仅两条）

```
wiki_graph_lint.py ──(sys.path 注入同目录, L58-60)──▶ wiki_graph_extract.py
    复用 build_nodes/build_edges —— 保证 lint 校验 = extract 产出
setup_wiki.py ──(同目录 import, L20)──▶ wiki_search.py
    复用 collect_pages/collect_sections/load_local_embedding_backend/
    open_vector_index/sync_vector_index/LOCAL_EMBED_MODEL/VECTOR_INDEX_NAME
init_wiki.py ──(subprocess: uv run --script setup_wiki.py, L144-147)──▶ setup_wiki.py
```

### 1.4 间接传递依赖（由 pinned 顶层引入）

fastembed 0.8.0 自带 onnxruntime（本地 CPU 推理）等；sqlite-vec 提供 SQLite vec0 虚拟表扩展。二者均在脚本进程内加载（`sqlite_vec.load(connection)`）。

## 2. Paperclip 插件（`integrations/paperclip/plugin/package.json`）

### 2.1 运行时（peerDependencies，宿主提供并 external 化）

| 包 | 版本 |
|---|---|
| `@paperclipai/plugin-sdk` | 2026.428.0（worker-rpc-host definePlugin/runWorker、ui 的 usePluginData/hooks、bundlers 的 createPluginBundlerPresets） |
| `react` / `react-dom` | >=18 |

### 2.2 devDependencies（构建期）

| 用途 | 包 |
|---|---|
| 构建 | esbuild ^0.28（配置经 SDK presets）、typescript ^5.6 |
| 测试 | vitest ^3、@testing-library/react ^16、@testing-library/dom、@testing-library/jest-dom、jsdom ^29 |
| Markdown 渲染 | react-markdown ^10、remark-gfm ^4、rehype-highlight ^7、rehype-slug ^6、rehype-autolink-headings ^7 |
| 类型 | @types/node ^22、@types/react(DOM) ^18 |

构建产物 externals：`react`、`react-dom`、`react/jsx-runtime`、`@paperclipai/plugin-sdk/ui`、`@paperclipai/plugin-sdk/ui/hooks`（esbuild.config.mjs 头注释）。

### 2.3 源码内部依赖

```
worker.ts ──▶ lib/{frontmatter,bm25,lint,stats}.ts + manifest.ts（WIKI_QUERY_DESCRIPTION）
ui/index.tsx ──▶ WikiSidebar/WikiPage/WikiContextTab/WikiHealthIndicator
                 /WikiPageView/ErrorBoundary ──▶ page/*、setup/*、HostLink、href、styles、WikiMarkdown
                 全部经 @paperclipai/plugin-sdk/ui 的 usePluginData 与 worker 通信（无直接 fetch）
```

## 3. 文档站（根 `package.json`，name `llm-wiki-plugin-docs`）

| 包 | 版本 | 用途 |
|---|---|---|
| vitepress | 1.6.4 | 静态站 |
| mermaid | 11.16.0 | 图表 |
| vitepress-plugin-mermaid | 2.0.17 | mermaid 集成 |

包管理 pnpm（`packageManager: pnpm@10.33.0`），Node ≥20（engines）。

## 4. 跨语言字节级对齐机制（本项目特色依赖关系）

Paperclip TS 与 Python 不是调用关系，而是**同一算法的双实现 + 快照锁**：

```
tests/fixtures/_gen_bm25_expectations.py（Python 生成器）
        │ 对固定语料跑 Python 参考实现，捕获期望输出
        ▼
tests/fixtures/bm25-expectations.json（快照）
        │
        ▼
tests/lib/{bm25,frontmatter,lint,stats}.spec.ts（vitest 断言 TS 输出 == 快照）
```

规则（`bm25.ts` L12-14）：改算法必须重新生成快照。对齐范围：BM25 常量与公式、分词器、frontmatter 解析行为（含静默丢弃与引号剥离顺序）、lint 九类发现与默认阈值、stats 全部统计口径与阈值消息。**语义通道（FastEmbed）不移植** — 插件保持词法。

## 5. 外部系统依赖（运行时）

| 系统 | 用途 | 必需性 |
|---|---|---|
| Claude Code 插件机制 | `/plugin marketplace add` 安装路径 | 仅 Claude Code 全插件体验 |
| agentskills.io / `npx skills` CLI | 其它 Agent 的技能安装 | 其它 Agent 路径 |
| Paperclip 宿主 | 插件运行环境 | 仅 Paperclip 集成 |
| Hugging Face（模型下载） | 首次获取 `BAAI/bge-small-en-v1.5` | 一次性，之后离线 |
| GitHub Pages / Actions | 文档发布与 CI | 开发者侧 |

**显式无依赖项**：无 OpenAI 兼容端点、无 API Key、无远程向量库、无查询文本外发（v3 设计目标 "Zero provider surface"）。

## 6. 版本耦合点

- `init_wiki.py` 的 `SCHEMA_SECTION_MARKERS` 把 SCHEMA 段落与插件版本绑定（0.3.0 图段落 / 2.0.0 Retrieval / 3.0.0 本地语义）。
- CHANGELOG 记录 v2.0.x 系列为远程 embedding 供应商模式的安全加固（consent 绑定供应商、凭据指纹、缓存版本 3），v3.0.0（2026-07-20）整体切本地并让旧 `embeddings.jsonl` 失效忽略。
- Paperclip 插件版本（0.5.1）独立演进，其 CI 同时监听 `skills/llm-wiki/references/agent-memory-integration.md`（安装指引文档与插件行为联动）。
