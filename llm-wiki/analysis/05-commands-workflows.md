# 05 · 斜杠命令、技能工作流与模板

> `commands/wiki/`（7 个 Claude Code 命令清单）+ `skills/llm-wiki/SKILL.md`（工作流总规范）+ `skills/llm-wiki/references/`（9 篇权威参考）+ `skills/llm-wiki/assets/`（7 个模板）

## 1. 七个 `/wiki:*` 斜杠命令

每个命令文件 = YAML frontmatter（name/description/参数提示）+ 面向 LLM 的步骤规范。命令是显式入口；自然语言同样触发底层技能。

| 命令 | 文件 | 流程要点 | 调用脚本 |
|---|---|---|---|
| `/wiki:init` | `init.md` | 先按 `references/retrieval-setup.md` 做分组访谈（wiki 路径 / raw 路径 / 模型缓存位置 / 是否用图 / agent-memory 集成）→ 运行 `init_wiki.py` → **等待 setup 报告 `"status": "ready"` 才算完成** → 征得同意后把 wiki 接线进 `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`（多 Agent 项目用 `AGENTS.md` 并 symlink `CLAUDE.md`；绝不经同意写入） | `init_wiki.py` → `setup_wiki.py` |
| `/wiki:ingest <source>` | `ingest.md` | 读 `SCHEMA.md` 定约定 → 原文落 `raw/` → 大文件分块读 → 写 `sources/` 摘要页（全 frontmatter + 回指 raw）→ `str_replace` 外科手术式更新既有实体/概念页（更新前重读 raw 核对，防 wiki 读自身输出漂移）→ 新建页面（保证 ≥1 入链）→ 更新 index/分片 → 追加 log → 有图时跑 graph lint+extract → 与用户讨论要点并提议回填 synthesis | `wiki_graph_lint.py`、`wiki_graph_extract.py` |
| `/wiki:query <question>` | `query.md` | 先读 SCHEMA + index（或分片）→ 候选页 → wikilink/backlink 扩展 → 索引不足时 `wiki_search.py` 混合检索（保持技能路径与 wiki 路径显式）→ 关系型问题查 `graph.sqlite`（neighbors/path/facts）→ 合成带 `[[wikilink]]` 引用的答案 → 提议回填 `wiki/synthesis/` → 覆盖不足时坦白说明并标记为候选 ingest 目标（不编造） | `wiki_search.py`、`wiki_graph_query.py` |
| `/wiki:lint` | `lint.md` | 跑 `wiki_lint.py`（+ 存在 ontology 时 `wiki_graph_lint.py`、可选 `wiki_search.py --top-linked`）→ LLM 补充语义检查（矛盾/缺页概念/缺口）→ **一切发现以建议编辑呈现，用户批准后才修复** → 修复后更新 index 与 log | `wiki_lint.py`、`wiki_graph_lint.py`、`wiki_search.py` |
| `/wiki:stats` | `stats.md` | 跑 `wiki_stats.py` → 汇报规模/索引行数/最大页/链接密度 → 按阈值给分片/拆页/lint 节奏建议 | `wiki_stats.py` |
| `/wiki:graph <action>` | `graph.md` | 分派：`extract`/`lint` → 对应脚本；`neighbors`/`edges`/`path`/`facts` → `wiki_graph_query.py` 子命令。强调图只是导航加速，证据仍回 wiki 页与 raw | `wiki_graph_extract.py`、`wiki_graph_lint.py`、`wiki_graph_query.py` |
| `/wiki:upgrade` | `upgrade.md` | 运行 `init_wiki.py --upgrade`（幂等补齐缺失文件）→ 按 `detect_schema_gaps` 输出逐段**交互式**合并 SCHEMA.md（绝不静默）→ 说明图层与本地语义检索的兼容行为（旧 Markdown 无需迁移；旧 `embeddings.jsonl` 忽略） | `init_wiki.py --upgrade` |

## 2. SKILL.md 工作流总规范（技能入口）

frontmatter 触发面（有意做宽）：来源积累类请求（论文/文章/转录/会议记录/书章/客户电话/代码库/日志）、"add this to my wiki"、"what does my wiki say about X"、"lint the wiki"、"second brain"、"personal knowledge base"、LLM Wiki/OmegaWiki 提及，甚至用户不说 wiki 但在持续积累文本材料时也触发。

核心章节：

| 章节 | 要点 |
|---|---|
| 三层三操作 | raw（不可变）/ wiki（LLM 拥有）/ SCHEMA（共同演化配置）；ingest/query/lint |
| 图图层（可选） | frontmatter `graph:` 类型化元数据 → 编译产物；**Markdown 恒为 canonical**；无 `graph.relationships` 的页面仍作为节点（由 type/kind 推导）并贡献低置信 `mentions` 边；typed 边必须显式 source+evidence，绝不凭训练数据推断；无 `wiki/graph/ontology.yaml` 视为 pre-graph，图步骤为 no-op |
| 默认布局 | `wiki/{SCHEMA,index,log}.md + entities/concepts/sources/synthesis + indexes(分片后)`；`raw/ + assets/`。已有异名 wiki（kb/notes/vault）则沿用 |
| 可扩展性纪律 | 原子页（软 400/硬 800）、索引优先、分片索引、frontmatter、str_replace 外科编辑、grep 反链、分块摄取、>300 页用检索脚本（详见 01 文档第 3 节） |
| 初始化 | bootstrap 前先访谈；setup 非 ready 不算完成；`--no-embed` 是词法逃生舱不是跳过安装的理由；随后提议 agent-memory 接线（canonical stanza 与三行短版在 `references/agent-memory-integration.md`；未经批准不写） |
| 四大失败模式 | 静默腐化 / 读自身输出漂移 / 维护棘轮 / 范围蔓延（详见 01 文档第 6 节） |
| 参考文件索引 | 9 篇 references "按需读，不预读"（L127-139） |
| 脚本与模板清单 | 8 脚本 + 7 模板一览（L141-164） |

## 3. 九篇 references（流程权威来源）

| 文件 | 职责 |
|---|---|
| `architecture.md` | 三层三操作深度解释：页面格式示例、每个设计选择的理由 |
| `ingest-workflow.md` | 分步摄取程序：大来源分块读取、每类页面模板 |
| `query-workflow.md` | index→页→backlink 导航模式、何时退到检索脚本、答案回填 synthesis |
| `lint-workflow.md` | 检查项、发现呈现方式、节奏（每 N 次 ingest 或每周，而非每次操作） |
| `page-conventions.md` | frontmatter schema、命名、链接语法、页面类型定义、尺寸规则 |
| `scaling-playbook.md` | 分片阈值与迁移步骤、引入检索脚本的时机、"wiki 长出当前约定"的信号 |
| `agent-memory-integration.md` | 接线 CLAUDE.md/AGENTS.md/GEMINI.md 的完整工作流、canonical stanza、三行短版、bootstrap 对话脚本 |
| `retrieval-setup.md` | init/upgrade 强制设置：路径、模型缓存、pinned 本地依赖、全语料向量同步、就绪检查、SCHEMA.md 非机密状态 |
| `graph-workflow.md` | 图层：ontology、frontmatter schema、何时加 typed 边 vs 纯 wikilink、extract/lint/query 流程 |

## 4. 七个模板（`assets/`）

bootstrap 时由 `init_wiki.py` 复制进用户 wiki（幂等，已存在不覆盖）：

| 模板 | 落点 | 内容 |
|---|---|---|
| `SCHEMA.md.template` | `wiki/SCHEMA.md` | 约定文档起点：页面类型、命名、标签分类法、ingest 定制、（0.3.0+）图段落、（2.0.0+）Retrieval、（3.0.0+）本地语义检索段。升级检测即对照此文件的段落标记 |
| `index.md.template` | `wiki/index.md` | 空索引 |
| `log.md.template` | `wiki/log.md` | 空日志 |
| `page.md.template` | `wiki/.page-template.md` | 通用页 scaffold：frontmatter `type(4选1)/title/tags/sources/created/updated` + 导语段 + 小节 + "Where this fits"（source 页列触及的实体/概念）。约定：frontmatter `sources:` 用裸 slug，正文才用 `[[wikilink]]`；未证实声明用对冲措辞 |
| `ontology.yaml.template` | `wiki/graph/ontology.yaml` | **谓词表**：12 节点类型（person/company/product/paper/place/organization/concept/source/synthesis 由 `maps_from(type[,kind])` 推导；decision/claim/raw 仅显式）；15 谓词 — 3 隐式（mentions/sourced_from/summarizes_raw，requires_evidence:false）+ 12 typed（founded/owns/contains_product/works_on/chose/proposed/competes_with/depends_on/authored/cites/contradicts/supersedes，均 requires_evidence:true 且带 subject_types/object_types 约束） |
| `graph_README.md.template` | `wiki/graph/README.md` | 图目录说明：canonical vs 生成物 |
| `graph_gitignore.template` | `wiki/graph/.gitignore` | 默认忽略 `graph.sqlite` 与 `graph.graphml`（JSONL 可留版本控制） |
| `wiki-cache_gitignore.template` | `wiki/.wiki-cache/.gitignore` | 忽略派生缓存 |

> 注：`.wiki-cache` 的 gitignore 模板在 SKILL.md 模板清单（L154-164）之外，但存在于 `init_wiki.py` 的复制映射（L200）与 assets 目录。

## 5. 与文档站的对应

`docs/commands.md` 是七个命令的用户侧文档；`docs/workflows.md`/`docs/search.md`/`docs/graph.md`/`docs/upgrade.md` 分别展开 ingest+query、检索、图层、升级主题；`docs/agents.md` 覆盖 8 个 Agent 的安装与调用方式矩阵；`docs/integrations.md` 为 Paperclip 集成页。
