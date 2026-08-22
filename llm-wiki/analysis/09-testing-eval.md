# 09 · 测试与评估体系

> 项目有两条质量线：① `eval/retrieval/` 检索质量评估（Python）；② Paperclip 插件的 vitest 单测/快照测试（TS）。

## 1. 检索评估 harness（`eval/retrieval/run_eval.py`，237 行）

### 1.1 工作方式

以**子进程**方式调用 `skills/llm-wiki/scripts/wiki_search.py`（L63-96 构造命令行、捕获 stdout 字节），在固定语料 `corpus/wiki` 与固定查询集 `queries.json` 上评估三种模式：

| 模式 | wiki_search.py flag 组合 |
|---|---|
| `page` | `--granularity page --no-embed`（整页 BM25 基线） |
| `section` | `--granularity section --no-embed`（分节 BM25） |
| `hybrid` | 分节 + 语义（默认路径） |

hybrid 是否可用由 `hybrid_available()`（L144-155）探测：跑一次不带 `--no-embed` 的搜索，读 JSON `mode` 是否为 `"hybrid"`。

### 1.2 指标（L99-141）

- 正例查询：**recall@5、recall@10、MRR** — 按**原始结果行**计算（切片前不做每页去重；分节命中按其页面 slug 计入命中）。
- 负例查询：**假阳率 fp_rate** — 前 5 出现至少一条结果的比例。

### 1.3 缓存字节不变式（L158-171）

三条固定查询（attention mechanism / quantization int8 / tensor parallelism）在 ①无缓存 ②冷缓存（首次调用建文件）③暖缓存 三种状态下 `--json` stdout **逐字节相同**（比较原始字节而非解码字符串）。失败直接 exit 1（无论是否 --gate）。

### 1.4 回归门禁 `--gate`（L217-231）

失败条件（exit 1）：
1. `section recall@10 < page recall@10`（分节检索不得劣于整页基线）
2. hybrid 可用时 `hybrid recall@10 < section recall@10`（语义融合不得劣化召回）
3. hybrid 可用时 `hybrid fp_rate > section fp_rate`（融合不得增加假阳）

### 1.5 运行

```bash
python3 eval/retrieval/run_eval.py          # 词法报告（表格输出到 stdout）
uv run --with fastembed==0.8.0 --with sqlite-vec==0.1.9 \
  python eval/retrieval/run_eval.py         # 含 hybrid
python3 eval/retrieval/run_eval.py --gate   # CI 门禁
```

## 2. 固定语料 `corpus/wiki/`（20 页 + SCHEMA.md）

ML 主题的迷你 wiki，结构与真实 wiki 完全一致：

| 目录 | 页面 |
|---|---|
| `concepts/`（7） | attention-mechanism、distributed-training、gradient-descent、kv-cache、mixture-of-experts、quantization、tokenization |
| `entities/`（5） | cuda、gpt-4、ilya-sutskever、openai、pytorch |
| `sources/`（5） | adam-paper、attention-paper、chinchilla-paper、lora-paper、scaling-laws-paper |
| `synthesis/`（3） | precision-tradeoffs、training-vs-inference-cost、why-transformers-won |

## 3. 查询集 `queries.json`

每条：`{id, kind: exact|paraphrase|filter|negative, query, expected: [slug…], filters?: {type, tag}}`。

- **exact**：精确词/错误码/标识符直达（如 `"RuntimeError expected scalar type Half"` → 期望 `quantization`；`"past_key_values"` → `kv-cache`；`"CUDA_ERROR_OUT_OF_MEMORY"` → `cuda`；`"DistributedDataParallel"` → `pytorch`；`"load balancing loss"` → `mixture-of-experts`）
- **paraphrase**：改写/概念性表述
- **filter**：携带 frontmatter 过滤器（type/tag）的查询，验证过滤路径与向量过滤检索
- **negative**：语料外主题，期望返回空

## 4. 专项回归测试（`eval/retrieval/test_*.py`）

| 文件 | 行数 | 覆盖 |
|---|---|---|
| `test_search_contracts.py` | 62 | CLI 契约：flag 组合、JSON 结构、退出码等稳定行为 |
| `test_embedding_mode.py` | 282 | v3 语义路径回归（CHANGELOG "Fixed" 条目对应的测试化）：索引复用、增量更新、删除分节、过滤范围的向量搜索、维度变更重建、依赖缺失/模型失败/sqlite-vec 加载失败时的词法降级与异常脱敏 |
| `test_setup.py` | 97 | `setup_wiki.py` 就绪报告回归（依赖版本、模型、页/节/向量计数一致性） |

## 5. Paperclip 插件测试（`integrations/paperclip/plugin/tests/`，vitest）

| 组 | 文件 | 覆盖 |
|---|---|---|
| lib 快照对齐 | `lib/{bm25,frontmatter,lint,stats}.spec.ts` | TS 实现对 `fixtures/bm25-expectations.json`（由 `_gen_bm25_expectations.py` 从 Python 参考实现生成）字节级一致 |
| 安全 | `security/symlinks.spec.ts` | symlink 逃逸防护（realpath 围栏、wiki 根 symlink、shard symlink） |
| UI | `ui/*.spec.tsx`（约 20 个） | 各组件行为：Reader（含 landing 态）、QuickSwitcher、FolderTree、BacklinksPanel、WikiContextTab、SetupView、Topbar、HostLink、WikiMarkdown、slots、useWikiLocation、ErrorBoundary、WikiHealthSetupBanner 等 |
| 契约 | `manifest.spec.ts`、`worker.spec.ts` | manifest 槽位/工具/配置 schema；worker 数据 provider 与工具行为 |
| 冒烟 | `_smoke.spec.ts` | 基础加载 |
| 夹具 | `fixtures/wiki/`（concepts/entities/sources/synthesis/raw 各若干页）+ `_setup.ts` | 测试语料与环境 |

测试环境：vitest 3 + jsdom 29 + @testing-library/react；`pnpm test` 一键全跑，prepublish:check 与 CI 强制通过。

## 6. 两条质量线的关系

```
Python 评估线：检索"质量"（召回/排序/假阳/缓存稳定性）—— 针对 wiki_search.py 本体
TS 测试线：  实现"一致性"（与 Python 字节对齐）+ UI 行为 + 安全 —— 针对伴随插件
```

Python 侧本身没有 pytest 单测套件（评估脚本即回归载体）；`test_*.py` 三个文件以脚本方式直接运行。
