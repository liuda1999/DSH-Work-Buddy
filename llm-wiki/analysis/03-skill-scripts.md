# 03 · 核心工具链：8 个 Python 脚本（关键函数说明）

> 位置：`skills/llm-wiki/scripts/`。行号以本压缩包源码为准。
> 依赖约定：带 PEP 723 内联元数据的脚本必须用 `uv run --script` 执行（uv 按元数据创建隔离环境）；纯 stdlib 脚本可直接 `python` 执行。

| 脚本 | 行数 | 依赖 | 一句话职责 |
|---|---|---|---|
| [init_wiki.py](#1-init_wikipy--bootstrap升级) | 253 | stdlib | 幂等创建 wiki 目录与模板，随后强制运行时安装 |
| [setup_wiki.py](#2-setup_wikipy--运行时门禁) | 78 | PEP 723 | 装依赖/缓存模型/全量同步向量，输出 ready JSON |
| [wiki_search.py](#3-wiki_searchpy--混合检索引擎) | 840 | PEP 723 | 分节级 BM25+语义混合检索、缓存、JSON 证据 |
| [wiki_lint.py](#4-wiki_lintpy--结构健康检查) | 315 | stdlib | 10 类结构问题检测 + 建页建议 |
| [wiki_stats.py](#5-wiki_statspy--规模统计) | 155 | stdlib | 规模/类型/密度统计 + 阈值建议 |
| [wiki_graph_extract.py](#6-wiki_graph_extractpy--图编译器) | 541 | PEP 723 | 页面 → 节点/边 → JSONL/SQLite/GraphML |
| [wiki_graph_lint.py](#7-wiki_graph_lintpy--图元数据校验) | 420 | PEP 723 | 对照 ontology 校验 typed 边（15 类发现） |
| [wiki_graph_query.py](#8-wiki_graph_querypy--图查询) | 263 | stdlib | neighbors/edges/path/facts 查询 graph.sqlite |

---

## 1. `init_wiki.py` — bootstrap/升级

CLI：`python init_wiki.py <project-root> [--wiki-dir wiki] [--raw-dir raw] [--upgrade]`

| 函数 | 行号 | 说明 |
|---|---|---|
| `copy_template(src, dst, substitutions)` | L78-88 | 模板落盘；**目标已存在则返回 False（幂等核心，绝不覆盖用户文件）** |
| `detect_schema_gaps(schema_path)` | L91-102 | 对照 `SCHEMA_SECTION_MARKERS`（L44-75，按版本标记 0.3.0 图段落 / 2.0.0 Retrieval / 3.0.0 本地语义）找出用户 SCHEMA.md 缺失的段落 |
| `print_schema_upgrade_guidance(...)` | L105-126 | 打印缺失清单并指引手工合并（"SCHEMA 与用户共同演化，脚本永不改写"） |
| `install_runtime(wiki)` | L129-153 | 找 `uv`（缺失则 fail-closed 退出）；`subprocess.run([uv, "run", "--script", setup_wiki.py, "--wiki", wiki, "--cache"], check=True)` — **init 与 setup 的衔接点** |
| `init_wiki(project_root, wiki_dir, raw_dir, upgrade)` | L156-238 | 主流程：创建 `SUBDIRS`（L39：sources/entities/concepts/synthesis/graph）+ `raw/assets` → 复制 8 个模板（L192-201 映射表，含 `page.md.template → wiki/.page-template.md`、`wiki-cache_gitignore → wiki/.wiki-cache/.gitignore`）→ 报告 created/skipped → `install_runtime` → upgrade 模式做 schema 差距检测，init 模式打印后续步骤 |
| `main()` | L241-249 | argparse |

## 2. `setup_wiki.py` — 运行时门禁

PEP 723（L2-9）：`fastembed==0.8.0`、`pyyaml==6.0.3`、`sqlite-vec==0.1.9`，`requires-python >=3.10`。

| 函数 | 行号 | 说明 |
|---|---|---|
| `prepare(wiki_root, cache_path)` | L23-54 | `wiki_search.collect_pages` → `collect_sections` → `load_local_embedding_backend`（下载/加载模型）→ `open_vector_index` → `sync_vector_index`（全量同步）；**一致性断言**：`vector_count != len(locator_ids)` 则抛错（L35-38）。返回就绪报告 dict |
| `main()` | L57-74 | `--wiki`、`--cache [path]`（const="AUTO" → `wiki/.wiki-cache/search-index.json`）；以 `json.dumps(..., indent=2)` 打印报告 |

**就绪报告契约**（init/upgrade 以 `"status": "ready"` 为完成判据）：

```json
{
  "status": "ready",
  "wiki": "<abs path>",
  "dependencies": {"fastembed": "...", "pyyaml": "...", "sqlite-vec": "..."},
  "model": "BAAI/bge-small-en-v1.5",
  "dimension": 384,
  "pages": N, "sections": N, "vectors": N,
  "vector_index": "<wiki>/.wiki-cache/embeddings.sqlite"
}
```

## 3. `wiki_search.py` — 混合检索引擎

PEP 723（L2-8）：`fastembed==0.8.0`、`sqlite-vec==0.1.9`。

模块常量（L52-59）：`WIKILINK_RE`、`FRONTMATTER_RE`、`TOKEN_RE = [a-z0-9]+`、`HEADING_RE`、`LOCAL_EMBED_MODEL = "BAAI/bge-small-en-v1.5"`、`VECTOR_INDEX_SCHEMA = "2"`、`VECTOR_INDEX_NAME = "embeddings.sqlite"`、`MAX_COSINE_DISTANCE = 0.35`。

### 3.1 解析与缓存层

| 函数 | 行号 | 说明 |
|---|---|---|
| `parse_frontmatter(text)` | L62-88 | 轻量 YAML-ish 解析（无 PyYAML 依赖）：支持 `key: value`、引号值、行内列表 `[a, b]`、块列表（`  - item`）；键正则 `^[a-zA-Z_]+:`；不匹配行静默丢弃。返回 `(meta, body)` |
| `tokenize(text)` | L91-92 | 小写化 + `[a-z0-9]+` 切词 |
| `slug_from_path(path, wiki_root)` | L97-98 | slug = 文件名去扩展名 |
| `extract_wikilinks(body)` | L101-102 | 提取 `[[target\|alias]]` 的 target |
| `cache_page_body(sections)` | L105-112 | 从缓存分节数据重建可检索 Markdown（标题行 + 正文拼接） |
| `load_parse_cache(cache_path)` | L115-155 | 读取并**深度校验**缓存（schema==1、逐条目类型检查 sha256/meta/links/sections 结构）；任何损坏 → 打印原因并返回 `{}` 重建 |
| `write_parse_cache(cache_path, files)` | L158-165 | 原子写（`.tmp` + `os.replace`），`sort_keys=True` 保证字节稳定 |
| `collect_pages(wiki_root, cache_path)` | L168-229 | 遍历 `*.md`：跳过顶层 SCHEMA/index/log、`indexes/`、`graph/`、`raw/`、`.wiki-cache/`、点文件；**SHA-256 内容哈希命中缓存则免解析**；否则解析并重建缓存条目。返回页面列表（含 tokens = tokenize(body+title)） |
| `split_sections(title, body)` | L232-271 | 按 ATX 标题（`#`~`######`）切分；**代码栅栏内（``` / ~~~）的标题不算**；维护标题栈生成 `heading_path`（如 `["Attention", "Scaled Dot-Product"]`） |
| `collect_sections(pages)` | L274-287 | 页面 → 分节行；`searchable_text = title + heading_path + text`，tokens 由此切出 |

### 3.2 BM25 层

| 函数 | 行号 | 说明 |
|---|---|---|
| `build_bm25(pages)` | L290-304 | 构建索引 dict：`{N, df(Counter), avgdl, doc_lens, term_freqs}` |
| `bm25_score(query_tokens, doc_idx, idx, k1=1.5, b=0.75)` | L307-323 | `idf = log(1 + (N-df+0.5)/(df+0.5))`；`score += idf * f*(k1+1) / (f + k1*(1-b+b*dl/avgdl))` |
| `parse_date(s)` | L326-332 | 取前 10 字符按 `%Y-%m-%d` 解析，失败返回 None |
| `passes_filters(page, args)` | L335-350 | `--type` 精确匹配；`--tag`（可重复）全部包含；`--since` 要求 `updated ≥ since` 且非空 |

### 3.3 语义层（本地 FastEmbed + sqlite-vec）

| 函数 | 行号 | 说明 |
|---|---|---|
| `embedding_failure_label(exc)` | L353-355 | 降级警告只暴露异常类名（不泄露路径/payload） |
| `section_locator(section)` | L358-360 | `"{rel_path}\x1f{section_index}"` — 分节唯一键 |
| `section_content_hash(section)` | L363-365 | `sha256(model + "\n" + searchable_text)` — **增量索引的变更检测单元**（模型名参与哈希，换模型自动全量重建） |
| `load_local_embedding_backend()` | L368-386 | 懒导入 `sqlite_vec` + `fastembed.TextEmbedding`（ImportError → RuntimeError 提示用 uv）；缓存目录 `FASTEMBED_CACHE_PATH` 环境变量，默认 `~/.cache/llm-wiki/fastembed`；返回 `(model, sqlite_vec, dimension)` |
| `open_vector_index(wiki_root, sqlite_vec, dimension)` | L389-429 | 打开 `.wiki-cache/embeddings.sqlite`，加载 vec0 扩展；`semantic_meta` 表存 schema/model/dimension，**任一不匹配 → DROP 两表全量重建**；建 `semantic_sections(id, locator UNIQUE, content_hash)` 与虚拟表 `semantic_vectors USING vec0(embedding float[dim] distance_metric=cosine)` |
| `embed_passages(model, texts)` | L432-436 | `passage_embed(batch_size=64)`，float 列表化 |
| `embed_query(model, text)` | L439-441 | `query_embed` 取首个向量 |
| `sync_vector_index(connection, sqlite_vec, model, sections)` | L444-515 | **增量同步核心**：stale（库有现无）→ 删除行+向量；changed（新 / 哈希变 / 向量行缺失）→ 批量嵌入（数量校验必须相等，L476-479）→ 事务内 UPSERT。返回 `locator → row_id` 映射 |
| `local_semantic_order(query, all_sections, allowed_locators, wiki_root)` | L518-570 | 同步索引后取语义排名：无过滤时用 vec0 原生 `embedding MATCH ? AND k=? ORDER BY distance`（KNN）；有过滤时建 TEMP 表 `allowed_sections` JOIN 后用 `vec_distance_cosine` 显式计算；两种路径都施加 `distance ≤ 0.35` 截断，取前 50 |

### 3.4 输出层与命令

| 函数 | 行号 | 说明 |
|---|---|---|
| `collapse_snippet(text)` | L573-574 | 空白折叠 + 截断 400 字符 |
| `json_result(score, page, section, sections, retrievers)` | L577-613 | 构造证据行：slug/rel_path/type/title/heading_path/section_index/score(4位小数)/retrievers/snippet/updated/tags/sources/**neighbors{prev,next}**（相邻小节标题，帮助 LLM 定位上下文） |
| `emit_json / emit_empty_json` | L616-627 | 顶层输出 `{query, wiki, granularity, mode: "lexical"\|"hybrid", results}` |
| `cmd_search(args, pages)` | L630-760 | **主命令**。`--granularity page`：纯 BM25 页面级。默认 section：BM25 分节排名 → 非 `--no-embed` 时走语义通道并 **RRF 融合**（L698-711）：`score = Σ 1/(60+rank)`，命中通道记入 `retrievers`（"bm25"/"embedding"）；候选 = BM25 前 50 ∪ 语义序（保持先词法后语义的稳定顺序）；**异常捕获 → 回退 lexical**（L713-719）。最后按 `--per-page`（默认 2）每页限条取 `--top` |
| `cmd_backlinks(args, pages)` | L763-775 | 反链查询：列出 body wikilink 指向目标 slug 的页面 |
| `cmd_top_linked(args, pages)` | L778-793 | 入链计数 Top-N（hub 页）；无对应页面者标 `[BROKEN LINK]` |
| `main()` | L796-836 | argparse 全量 flag：`query`（可空）、`--wiki`（默认 ./wiki）、`--top 10`、`--type`、`--tag`（可重复）、`--since`、`--backlinks`、`--top-linked`、`--cache [path]`、`--granularity section\|page`、`--per-page 2`、`--json`、`--no-embed`。分发：backlinks > top-linked > query > help |

## 4. `wiki_lint.py` — 结构健康检查

CLI：`python wiki_lint.py [wiki-dir] [--soft-cap 400] [--hard-cap 800] [--required-fm type,title,tags,created,updated] [--suggest-pages] [--suggest-min 5] [--json]`

| 函数 | 行号 | 说明 |
|---|---|---|
| `parse_frontmatter(text)` | L46-73 | 与 wiki_search 版本的差异：返回三元组 `(meta, body, malformed)` — 以 `---` 开头但正则不匹配 → malformed=True |
| `collect_pages(wiki_root)` | L76-107 | 跳过 SCHEMA/index/log/README 顶层文件 + indexes/graph/raw 目录 + 点文件；读失败页记录 `read_error` 继续扫描 |
| `lint(pages, ...)` | L119-241 | **10 类发现**：orphans（零入链）/ broken_links / oversized_hard(>800) / oversized_soft(>400) / missing_frontmatter / malformed_frontmatter / duplicate_slugs / stale_pages（**启发式：updated>90 天 且 入链≥3 的 hub**）/ read_errors / suggested_pages（`--suggest-pages`：`CAPITALIZED_PHRASE_RE` L39 挖掘出现在 ≥`--suggest-min` 页的大写短语且无对应页面/标题，过滤 Section/Where 等标题噪音，Top 30）+ summary 计数。构建 slug→入链 map（L150-154）后逐页检查 |
| `render_text(findings)` | L244-286 | 文本报告（每类截断 50 条）；全零 → "No issues found. Wiki is healthy." |
| `main()` | L289-311 | 解析参数，JSON 或文本输出 |

设计立场（文件头 L9）："Conservative by design: reports findings, never edits."

## 5. `wiki_stats.py` — 规模统计

CLI：`python wiki_stats.py [wiki-dir]`（无其它 flag）

| 函数 | 行号 | 说明 |
|---|---|---|
| `parse_type(text)` | L29-38 | 仅提取 frontmatter `type:` 行 |
| `main()` | L41-152 | 单遍扫描统计：总页/行/词/链接、按 type、按顶层目录（根页记 `(root)`）、最大 10 页（带超限标注）、入链 Top10 hub、`index.md` 行数（>300 标"← shard recommended"）、平均行/词、链接密度（links/pages）；**L140-151 输出阈值建议**（阈值表见 [01-architecture.md](01-architecture.md#3-可扩展性设计防上下文瓶颈)）。注意：`index.md` 不计入页面统计（与 lint/stats 的 SKIP 集差异见 06 文档对照表） |

## 6. `wiki_graph_extract.py` — 图编译器

PEP 723（L2-7）：`pyyaml==6.0.3`。CLI：`uv run --script wiki_graph_extract.py <wiki> [--out <wiki>/graph] [--formats jsonl,sqlite,graphml] [--ontology <path>]`

| 函数 | 行号 | 说明 |
|---|---|---|
| `parse_frontmatter(text)` | L68-81 | **用 `yaml.safe_load` 全量解析**（与 search/lint 的轻量解析不同 — 图元数据结构复杂） |
| `collect_pages(wiki_root)` | L84-106 | 排序遍历（保证产物确定性）；rel_path 统一 `/` 分隔 |
| `load_ontology(path)` | L114-124 | 读 ontology.yaml，缺省 `{"node_types":{}, "predicates":{}}`；解析错误 exit 2 |
| `derive_node_type(meta, ontology)` | L127-147 | 优先级：显式 `graph.node_type` > ontology `maps_from` 的 `(type, kind)` 双匹配 > 仅 type 匹配 |
| `build_nodes(pages, ontology)` | L155-193 | 节点 id = 显式 `graph.node_id` 或 **`{node_type}:{slug}`**（默认类型 concept）；重复 id 首个胜出（lint 会标记）；节点字段含 aliases/canonical/created/updated/tags；同时产出 alias 行 |
| `edge_id(subject, predicate, obj, source, evidence)` | L196-202 | 五元组 `\x1f` 连接后 SHA-256 取前 24 hex（96 bit，可读且碰撞可忽略）— **幂等去重键** |
| `make_edge(...)` | L205-219 | 边 dict 构造：id/subject/predicate/object/source/evidence/confidence/status/extraction_method/page/extras |
| `build_edges(pages, slug_to_id)` | L222-322 | **四类边来源**（push 去重）：① `graph.relationships[]` → typed 语义边（extraction_method=`explicit_graph_frontmatter`，extras 透传 valid_from/valid_to/notes/raw_ref/contradicts/supersedes）；② body wikilink → `mentions`（confidence=low）；③ 非 source 页的 frontmatter `sources:` → `sourced_from`（high）；④ source 页的 `raw:` → `summarizes_raw`（对象是 `raw:<path>` 字符串字面量，high） |
| `write_jsonl(out_dir, nodes, edges)` | L340-350 | 按 id 排序写 `nodes.jsonl` / `edges.jsonl`（`sort_keys` 保证字节稳定） |
| `write_sqlite(out_dir, nodes, aliases, edges)` | L353-437 | 重建 `graph.sqlite`：表 `nodes`（id PK/slug UNIQUE/title/page_type/node_type/kind/path/created/updated/metadata_json）、`aliases`（复合主键+外键）、`edges`（id PK/subject/predicate/object/source/evidence/confidence/status/extraction_method/page/metadata_json）；**4 个索引**：subject/object/predicate/source |
| `write_graphml(out_dir, nodes, edges)` | L440-490 | 用 `xml.etree` 写 `graph.graphml`：8 个 key（节点 title/node_type/page_type/path；边 predicate/confidence/status/source），directed graph |
| `main()` | L498-537 | 校验 formats ⊆ {jsonl,sqlite,graphml}；编译并打印节点/边数与**按谓词的边数分布表** |

## 7. `wiki_graph_lint.py` — 图元数据校验

PEP 723：`pyyaml==6.0.3`。CLI：`uv run --script wiki_graph_lint.py [wiki-dir] [--ontology <path>] [--json]`

关键结构：**L58-60 将脚本目录插入 `sys.path` 后 `import wiki_graph_extract as _extract`** — lint 直接复用 extract 的 `build_edges`，保证"lint 校验的就是 extract 将产出的"。

| 函数/常量 | 行号 | 说明 |
|---|---|---|
| `ALLOWED_CONFIDENCE` / `ALLOWED_STATUS` / `IMPLICIT_PREDICATES` | L69-71 | `high\|medium\|low`；`current\|historical\|proposed\|disputed\|superseded`；`mentions\|sourced_from\|summarizes_raw` |
| `derive_node_id(meta, slug, ontology)` | L134-140 | 与 extract 相同的 id 推导（显式 > `{node_type}:{slug}`） |
| `types_match(allowed, actual)` | L143-148 | 空列表=不限；含 `"*"`=通配；否则精确 |
| `lint(pages, ontology)` | L151-324 | **15 类发现**：duplicate_node_ids / unknown_predicates（不在 ontology）/ broken_object_refs（对象不可解析且谓词 object_types 不含 `*`）/ subject_type_mismatch / object_type_mismatch / missing_evidence / missing_source_field（requires_evidence 谓词必须带 source+evidence）/ broken_source_refs（source 必须命中现有 source 页 slug）/ invalid_confidence / invalid_status / duplicate_canonical / alias_collisions（别名跨节点冲突）/ broken_contradicts / broken_supersedes / **orphan_typed_nodes**（声明了 `graph:` 但提取后无任何 typed 边触及；source 节点豁免，L293-316）。summary 含 pages_scanned/nodes 与各类计数 |
| `render_text / main` | L327-416 | 文本渲染（每类 50 条截断）；ontology 缺失 → exit 1 并提示 seed ontology.yaml.template |

## 8. `wiki_graph_query.py` — 图查询

CLI：`python wiki_graph_query.py <wiki-dir> [--db <path>] [--json] <subcommand>`

| 函数 | 行号 | 说明 |
|---|---|---|
| `open_db(path)` | L40-47 | 打开 graph.sqlite（`row_factory=Row`）；缺失 → 提示先跑 extract，exit 1 |
| `fetch_node / edges_from / edges_to` | L50-72 | 节点查取；按 subject/object（可加 predicate 过滤）查边，排序保证稳定 |
| `truncate(text)` | L75-80 | evidence 摘要截断 140 字符（`EVIDENCE_SNIPPET_LEN`） |
| `cmd_neighbors(conn, args)` | L97-122 | 一跳邻居：合并出边对象与入边主体，解析邻居 title/path |
| `cmd_edges / cmd_facts` | L125-139 | 某主体的出边列表；某节点的出+入全集 |
| `cmd_path(conn, args)` | L142-167 | **BFS 最短有向路径**，`--max-depth` 默认 6；返回 path_nodes + path_edges |
| `render(result, command)` | L170-208 | 四种命令的文本渲染；边行含 `subject --[predicate]--> object`、via/conf/status、evidence 摘要、来源页 |

文件头明确定位（L6-8）：图只是**导航加速器**；高风险结论必须沿 `source` 字段回到 wiki 页与 raw 文件核对。

---

## 附：脚本调用关系图

```
/wiki:init 或 /wiki:upgrade（commands/wiki/*.md）
        │
        ▼
init_wiki.py ──uv run --script──▶ setup_wiki.py
                                      │ import
                                      ▼
                                 wiki_search.py ◀──（子进程 --json）── eval/retrieval/run_eval.py

/wiki:query ──▶ wiki_search.py（hybrid）/ wiki_graph_query.py（关系型问题）
/wiki:ingest ─▶ wiki_graph_lint.py ──import──▶ wiki_graph_extract.py（build_nodes/build_edges 复用）
                 wiki_graph_extract.py
/wiki:lint ──▶ wiki_lint.py + wiki_graph_lint.py + wiki_search.py --top-linked
/wiki:stats ─▶ wiki_stats.py
```
