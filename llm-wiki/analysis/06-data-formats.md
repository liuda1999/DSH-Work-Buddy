# 06 · 数据模型与文件格式

## 1. Wiki 页面 frontmatter 契约

最小必填集（`wiki_lint.py --required-fm` 默认）：`type, title, tags, created, updated`。

```yaml
---
type: source|entity|concept|synthesis   # 页面类型
title: "人类可读标题"
tags: [ml, inference]                    # 行内列表或块列表（  - item）
sources: [attention-paper]               # 裸 slug 列表（仅正文用 [[wikilink]]）
created: YYYY-MM-DD
updated: YYYY-MM-DD
kind: person|company|product|paper|...   # 可选：实体的子类型（参与图节点类型推导）
raw: raw/example.pdf                     # 仅 source 页：指向 raw/ 原文
graph:                                   # 可选：图图层元数据
  node_id: product:konvy                 # 可选显式 id（默认 {node_type}:{slug}）
  node_type: product                     # 可选显式类型
  aliases: [Konvy]
  canonical: true
  relationships:
    - predicate: founded                 # 必须在 ontology.yaml 谓词表中
      object: company:acme               # 目标节点 id（或字面量，见 object_types 通配）
      source: attention-paper            # 必须命中现有 source 页 slug
      evidence: "原文引用句"               # typed 边强制
      confidence: high|medium|low
      status: current|historical|proposed|disputed|superseded
      valid_from: / valid_to: / notes: / raw_ref: / contradicts: / supersedes:  # 可选 extras
---
```

**解析器差异**（重要）：

| 解析器 | 位置 | 能力 |
|---|---|---|
| 轻量正则版 | `wiki_search.py` L62-88 / `wiki_lint.py` L46-73 / Paperclip `frontmatter.ts` L57-102 | 键 `^[a-zA-Z_]+:`；标量/引号/两种列表；不支持的行静默丢弃；lint 版额外报 malformed。**字节级跨语言一致** |
| PyYAML 版 | `wiki_graph_extract.py` L68-81 / `wiki_graph_lint.py` L74-86 | `yaml.safe_load` 全量解析 — 支持嵌套 `graph:` 结构 |

## 2. 派生缓存（`wiki/.wiki-cache/`）

### 2.1 解析缓存 `search-index.json`（schema 1）

```json
{
  "schema": 1,
  "files": {
    "concepts/attention.md": {
      "sha256": "<整文件字节哈希>",         // 命中则整页免解析
      "meta": { "type": "concept", ... },
      "links": ["transformer", ...],
      "sections": [
        { "heading_path": ["Attention", "…"], "level": 2, "text": "…" }
      ]
    }
  }
}
```

- 原子写：`.tmp` + `os.replace`；`sort_keys=True` 保证字节稳定（评估 harness 的缓存字节不变式依赖此点）。
- 读取时逐条深度校验，任何损坏 → 整体重建（不部分信任）。

### 2.2 向量索引 `embeddings.sqlite`（schema "2"）

| 表 | 结构 | 说明 |
|---|---|---|
| `semantic_meta` | `(key TEXT PK, value TEXT)` | 存 schema/model/dimension 三元组；**与期望不符 → DROP 向量表全量重建**（换模型/维度自动迁移） |
| `semantic_sections` | `(id INTEGER PK, locator TEXT UNIQUE, content_hash TEXT)` | locator = `"{rel_path}\x1f{section_index}"`；content_hash = `sha256("{model}\n{searchable_text}")` |
| `semantic_vectors` | vec0 虚拟表 `embedding float[dim] distance_metric=cosine`，rowid 关联 sections.id | sqlite-vec 管理；KNN 用 `embedding MATCH ? AND k=?` |

增量同步语义：删除（库有现无）→ 删行+向量；新增/哈希变/向量缺失 → 批量 passage_embed(64) 后事务内 UPSERT。

## 3. 图图层产物（`wiki/graph/`）

### 3.1 `ontology.yaml`（canonical 契约）

```yaml
node_types:
  <name>:
    maps_from: { type: <page type>, kind: <page kind> }   # 或 explicit_only: true
predicates:
  <name>:
    subject_types: [...]        # 支持通配 "*"
    object_types: [...]
    requires_evidence: true|false
    description: |
      ……
```

默认模板：12 节点类型、15 谓词（3 隐式 + 12 typed，见 [05-commands-workflows.md](05-commands-workflows.md) 第 4 节）。

### 3.2 `nodes.jsonl`（每行一节点，按 id 排序）

```json
{"id":"product:konvy","slug":"konvy","title":"Konvy","page_type":"entity",
 "node_type":"product","kind":"product","tags":[],"aliases":[],
 "path":"entities/konvy.md","created":"…","updated":"…","canonical":false}
```

### 3.3 `edges.jsonl`（每行一边，按 id 排序）

```json
{"id":"<sha256前24hex>","subject":"person:x","predicate":"founded",
 "object":"company:y","source":"some-source-page","evidence":"…",
 "confidence":"high","status":"current",
 "extraction_method":"explicit_graph_frontmatter|body_wikilink|frontmatter_sources|frontmatter_raw",
 "page":"entities/x.md","extras":{"valid_from":"…","contradicts":"…"}}
```

`edge_id = sha256(subject ␟ predicate ␟ object ␟ source ␟ evidence)[:24]` — 内容寻址，天然去重与幂等重建。

### 3.4 `graph.sqlite`

表 `nodes`（id PK / slug UNIQUE / title / page_type / node_type / kind / path / created / updated / metadata_json{tags,aliases,canonical}）、`aliases`（复合 PK + FK）、`edges`（id PK / subject / predicate / object / source / evidence / confidence / status / extraction_method / page / metadata_json=extras）；索引：`idx_edges_{subject,object,predicate,source}`。每次 extract 整库重建。

### 3.5 `graph.graphml`

GraphML XML（directed）；节点 data 键：title/node_type/page_type/path；边 data 键：predicate/confidence/status/source。供 Gephi 等外部可视化。

## 4. CLI JSON 输出契约

### 4.1 `wiki_search.py --json`

```json
{
  "query": "…", "wiki": "wiki", "granularity": "section", "mode": "hybrid|lexical",
  "results": [{
    "slug": "attention", "rel_path": "concepts/attention.md",
    "type": "concept", "title": "Attention Mechanism",
    "heading_path": ["Scaled Dot-Product"], "section_index": 2,
    "score": 0.0312, "retrievers": ["bm25", "embedding"],
    "snippet": "≤400 字符折叠摘要", "updated": "2026-07-01",
    "tags": [], "sources": [],
    "neighbors": { "prev": "上一节标题", "next": "下一节标题" }
  }]
}
```

Page 粒度时无 heading_path/section_index/neighbors；page 粒度 retrievers 恒 `["bm25"]`。

### 4.2 `setup_wiki.py`（就绪报告）

见 [03-skill-scripts.md](03-skill-scripts.md) 第 2 节。init/upgrade 完成的唯一判据：`"status": "ready"`。

### 4.3 `wiki_lint.py --json` / `wiki_graph_lint.py --json`

findings dict：类别数组（每项含定位字段）+ `summary` 计数。graph lint 的定位格式为 `{page, predicate, object, index}`（第 index 条 relationship）。

### 4.4 `wiki_graph_query.py --json`

`neighbors` → `{node, neighbors:[{node_id,title,path,out[],in[]}]}`；`edges` → `{subject, predicate, edges[]}`；`facts` → `{node, outbound[], inbound[]}`；`path` → `{from, to, path_nodes[], path_edges[]}`（未达 → 空数组）。

### 4.5 Paperclip worker 数据契约

| Provider | 请求参数 | 返回 |
|---|---|---|
| `readPage` | `{companyId, projectId?, slug}` | `{slug, meta, body, links}` 或 `{error}` |
| `searchWiki` | `{companyId, projectId?, query, topK?, filters?{type,tags,since}}` | `{results: PageRefResult[]}` |
| `loadIndex` | `{companyId, projectId?}` | `{index, shards:[{name,text}], pages: PageRefResult[]}` |
| `wikiHealth` | `{companyId, projectId?}` | `{pageCount, indexLines, linkDensity, scalingMessages[], lintStatus:"pass"\|"warn"\|"fail", lintFindings, wikiPathMissing, lintCheckIntervalMinutes}` |
| `backlinks` | `{companyId, projectId?, slug}` | `{results:[{slug,title,type,snippet}]}` |
| `relevantForIssue` | `{companyId, issueId, topK?}` | `{results: PageRefResult[]}` |
| `verifySetup` | `{companyId, projectId?}` | `{wiki:{found,path,pageCount}, tool:{registered}, sample:{query,resultCount,durationMs}}` |
| `wiki.query` 工具 | `{query, topK?, type?, tag?}` | `content`（`- [[slug]] (type) — title § heading` 行列表）+ `data.results` |

`PageRefResult = {slug, title, type, score?, relPath?, heading?, snippet?}`（worker.ts L50-58）。

## 5. 各工具的扫描范围对照

| 工具 | 跳过的顶层文件 | 跳过的目录 |
|---|---|---|
| `wiki_search.py` | SCHEMA.md、index.md、log.md | indexes/、graph/、raw/、.wiki-cache/ |
| `wiki_lint.py` | SCHEMA.md、index.md、log.md、README.md | indexes/、graph/、raw/ |
| `wiki_stats.py` | SCHEMA.md、log.md、README.md（**index.md 计行数但不计页**） | indexes/、graph/、raw/ |
| graph extract/lint | SCHEMA.md、index.md、log.md、README.md | indexes/、graph/、raw/ |
| Paperclip bm25.ts | SCHEMA.md、index.md、log.md | indexes/、graph/、raw/、.wiki-cache/ |
| Paperclip lint.ts / stats.ts | 同 Python 对应脚本 | 同 Python 对应脚本 |

另：所有工具都跳过点开头的文件。
