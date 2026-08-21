# 01 · 项目整体架构

## 1. 设计思想：LLM Wiki 模式

传统 RAG 每次查询都从原始文本块重新推导知识，什么也不累积。LLM Wiki 把流程倒转：**新来源到达时由 LLM 一次性编译进持久化、结构化的 Wiki**（抽取概念、写实体页、更新交叉引用、标记矛盾），后续查询读取的是预合成的 Wiki 而非原始来源。知识随使用复利增长。

用户负责筛选来源和提问；LLM 负责人类总会放弃的整理、链接、一致性维护工作。

## 2. 三层模型 + 三操作 + 可选第四层

```
┌─────────────────────────────────────────────────────────────────┐
│  第一层：raw/   原始来源（不可变，LLM 只读不改）                    │
│          PDF、Markdown 剪藏、访谈转录、笔记、raw/assets/ 图片       │
└──────────────────────────────┬──────────────────────────────────┘
                               │ ingest（编译）
┌──────────────────────────────▼──────────────────────────────────┐
│  第二层：wiki/   LLM 拥有的 Markdown 页面                          │
│    SCHEMA.md   ← 约定文档（"配置文件"，与用户共同演化，读它优先）      │
│    index.md    ← 全页面目录（每页一行摘要，超 300 行分片到 indexes/）│
│    log.md      ← 只追加的时间线（ingest/query/lint 记录）           │
│    entities/   ← 具体事物（人、产品、论文、地点）                    │
│    concepts/   ← 思想、方法、框架                                   │
│    sources/    ← 每个来源一页摘要（带 raw/ 引用）                    │
│    synthesis/  ← 跨领域分析、对比、被回填的查询答案                   │
└──────────────────────────────┬──────────────────────────────────┘
                               │ extract（编译，可随时重建）
┌──────────────────────────────▼──────────────────────────────────┐
│  第三层（可选）：wiki/graph/   编译图图层                            │
│    ontology.yaml   ← 唯一权威契约：节点类型 + 谓词表                 │
│    nodes.jsonl / edges.jsonl / graph.sqlite / graph.graphml       │
│    （全部为派生物，删掉可重建；Markdown 才是 canonical）              │
└─────────────────────────────────────────────────────────────────┘

派生缓存（不进版本库语义）：wiki/.wiki-cache/
    search-index.json   ← 解析缓存（schema 1，SHA-256 内容哈希增量）
    embeddings.sqlite   ← 向量索引（schema "2"，sqlite-vec vec0 虚表）
```

**三个操作**（对应三个核心命令/工作流）：

| 操作 | 流程 | 支撑脚本 |
|---|---|---|
| **ingest** | 原文落 raw/ → 分块读取 → 写 sources/ 摘要页 → `str_replace` 外科手术式更新既有实体/概念页 → 新建页面（保证至少一个入链）→ 更新 index → 追加 log → 图 lint+extract | `wiki_graph_lint.py`、`wiki_graph_extract.py` |
| **query** | 先读 index（或分片）→ 从一行摘要定位候选页 → 读页面与其 backlink → 合成带 `[[wikilink]]` 引用的答案 → 可选回填 synthesis/；索引不够时降级到混合检索脚本 | `wiki_search.py`、`wiki_graph_query.py` |
| **lint** | 结构检查（孤儿页/断链/超限/frontmatter/陈旧）+ 语义检查（矛盾、缺页概念）；结果以"建议编辑"呈现，绝不静默改写 | `wiki_lint.py`、`wiki_graph_lint.py`、`wiki_stats.py` |

## 3. 可扩展性设计（防"上下文瓶颈"）

该模式最大的失败方式是 Wiki 长大后自己变成上下文瓶颈。全部设计围绕规避它：

1. **原子页面**：一页一概念；软上限 400 行、硬上限 800 行（lint 强制）。
2. **索引优先导航**：绝不盲目 grep；先读 index（每页一行、无正文）再钻取。
3. **分片索引**：index.md >300 行或全库 >150 页时，按类别分片到 `indexes/<type>.md`，顶层 index 变为分片目录。
4. **全页面 YAML frontmatter**：`type/tags/updated` 可不读正文直接过滤（`wiki_search.py` 的过滤路径）。
5. **外科手术式编辑**：更新用 `str_replace` 只动相关小节，不重写整页。
6. **分块摄取**：大 PDF/转录按块读，不整读。
7. **检索脚本兜底**：>300 页后索引摘要不够模糊查询用，切换到 `wiki_search.py` 分节混合检索。

规模阈值（`wiki_stats.py` L140-151 输出）：

| 页数 | 动作 |
|---|---|
| <50 | 平面结构即可 |
| 50–150 且 index <300 行 | 单 index.md 继续 |
| ≥150 或 index ≥300 行且无 `indexes/` | **到达分片阈值**，按 scaling-playbook 分片 |
| ≥300 | 把 `wiki_search.py` 作为常规兜底 |
| ≥500 | 每周或每 N 次 ingest 跑一次 lint |

## 4. 混合检索流水线（v3 默认路径）

```
query
  │
  ▼
collect_pages（解析缓存：SHA-256 命中则免解析）
  │  过滤（--type/--tag/--since，仅读 frontmatter）
  ▼
collect_sections（页面 → 分节，ATX 标题切分，跳过代码栅栏）
  │
  ├─────────────────┬──────────────────────────────┐
  ▼                 ▼                              │
BM25 索引        语义通道（可 --no-embed 关闭）       │
k1=1.5 b=0.75     sync_vector_index（增量：          │
IDF=log(1+        仅嵌入内容哈希变化的新/改分节，      │
 (N-df+.5)/(df+.5)) 删除已消失分节）                  │
  │                 sqlite-vec vec0 cosine KNN       │
  │                 MAX_COSINE_DISTANCE=0.35 截断    │
  └────────┬────────┘
           ▼  RRF 融合（k=60）：score = Σ 1/(60+rank_i)
           ▼  每页最多 per-page 条（默认 2）→ top N
           ▼
  --json 证据行：slug/rel_path/type/title/heading_path/
  section_index/score/retrievers/snippet/updated/tags/
  sources/neighbors{prev,next}
```

降级策略：语义通道任何异常（缺依赖、模型失败、sqlite-vec 加载失败）→ 打印脱敏警告（仅异常类名，不泄露路径）→ 回退纯词法 BM25，JSON 中 `mode` 从 `hybrid` 变 `lexical`。

## 5. 运行时拓扑（三个交付面）

```
┌─────────────────── Agent 侧（写入者） ───────────────────┐
│ Claude Code 插件：/plugin install llm-wiki@llm-wiki      │
│   .claude-plugin/  → 插件与市场清单                       │
│   commands/wiki/   → 7 个斜杠命令（Claude Code 专属）      │
│   skills/llm-wiki/ → SKILL.md + 8 个 Python 脚本 + 模板   │
│                                                          │
│ 其它 Agent（Codex/Cursor/Gemini CLI/OpenCode/Pi/OMP…）：  │
│   npx skills add …（agentskills.io 标准格式，仅技能）       │
│   自然语言触发 SKILL.md 工作流，脚本同样可执行              │
└───────────────┬──────────────────────────────────────────┘
                │ 同一个 wiki/ 目录（Agent 无关，纯 Markdown）
                ▼
┌─────────── Paperclip 插件（只读者，人类侧） ────────────────┐
│ integrations/paperclip/plugin/（npm: paperclip-plugin-    │
│ llm-wiki v0.5.1）                                          │
│   worker 进程：8 个数据 provider + wiki.query agent 工具    │
│   UI bundle：4 个槽位组件（侧栏/全页/issue 标签页/仪表盘）    │
│   策略：技能负责写（心跳），插件只负责读                     │
└───────────────────────────────────────────────────────────┘
```

关键分工：**斜杠命令是 Claude Code 专属；技能与脚本对所有 Agent 可用；Wiki 本身 Agent 无关**（用 A 写入、用 B 查询完全成立）。

## 6. 关键设计决策与风险防御

| 失败模式 | 缓解机制 |
|---|---|
| 静默腐化（误读被写进权威页面并影响后续 ingest） | 每条 wiki 声明必须带 `sources:` frontmatter 指回 raw 文件；lint 检查不可定位来源的声明；未证实内容用对冲措辞 |
| Wiki 读自己输出的漂移（把 wiki 页当地面真相） | ingest 更新既有页时必须重读相关 raw 原始来源核对 |
| 维护棘轮（监督成本随规模上升） | 可扩展性纪律（分片/原子页/frontmatter/lint）+ lint 节奏；报告超负荷 = 需要修订 schema |
| 范围蔓延到错误场景 | 高度关系型数据（10 万客户记录、财务账本）明确建议用真数据库 |
| 图层被当成权威 | typed 边强制 source 页 slug + evidence 引文，禁止凭训练数据推断；`mentions` 显式标注为低置信导航边 |
