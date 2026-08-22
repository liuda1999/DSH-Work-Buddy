# 04 · Paperclip 集成插件（TypeScript）

> 位置：`integrations/paperclip/plugin/`（npm 包 `paperclip-plugin-llm-wiki` v0.5.1）
> 定位：**人类侧只读伴随插件**。技能（Python）在心跳中写 wiki；本插件把 wiki 带进 Paperclip 操作台供人阅读。只读是契约（SPEC Non-goals）：worker 不注册任何 action，从不写盘。

## 1. 宿主模型与总体架构

Paperclip 插件 SDK（`@paperclipai/plugin-sdk` 2026.428.0）的模型：

```
┌─────────────── Paperclip 宿主 ────────────────┐
│  manifest 校验（安装时验证 dist/manifest.js）    │
│  worker：子进程运行 dist/worker.js（Node 后端）  │
│  UI：同源 JS 加载 dist/ui/index.mjs             │
│      （react/react-dom/SDK 作为 external 由宿主 │
│       提供；UI 不得直连外部 API，一切后端流量走   │
│       usePluginData / usePluginAction）         │
└───────────────────────────────────────────────┘
```

构建产物（esbuild，`esbuild.config.mjs` 用 SDK 的 `createPluginBundlerPresets`）：
- `dist/manifest.js` — 宿主安装时校验的清单模块
- `dist/worker.js` — worker 入口（宿主以子进程启动）
- `dist/ui/index.mjs` — UI bundle，按 manifest 的 `exportName` 查找命名导出

## 2. `src/manifest.ts`（147 行）— 插件契约

| 区块 | 行号 | 内容 |
|---|---|---|
| `WIKI_QUERY_DESCRIPTION` | L9-10 | `wiki.query` 工具描述（导出供 worker 运行时注册复用同一字符串，保证 manifest 与 toolbelt 一致） |
| manifest 对象 | L30-145 | id `io.praneybehl.llm-wiki`、apiVersion 1、version 0.5.1、categories `["workspace"]` |
| `capabilities` | L40-49 | 8 项：`ui.sidebar/page/detailTab/dashboardWidget.register`、`agent.tools.register`、`projects.read`、`project.workspaces.read`、`issues.read` |
| `ui.slots` | L56-84 | 4 槽位：sidebar `WikiSidebar`；page `WikiPage`（routePath `llm-wiki`）；detailTab `WikiContextTab`（entityTypes `["issue"]`）；dashboardWidget `WikiHealthIndicator` |
| `tools` | L87-118 | `wiki.query`：参数 `{query(必填), topK(1-20,默认5), type, tag}`（JSON Schema） |
| `instanceConfigSchema` | L120-144 | `wiki_path`（默认 "wiki"，相对公司主 workspace）、`lint_check_interval_minutes`（默认 60，最小 5）、`search_top_k`（默认 5，1-20） |

L20-27 注释记录了相对 SPEC.md 的勘误（categories 复数、无 sdkVersion、`project.workspaces.read` 为事实上的 FS 门、events.subscribe 移除）— 依据 FEASIBILITY.md 对照 SDK 源码验证。

## 3. `src/worker.ts`（730 行）— 后端核心

### 3.1 配置与参数解析

| 函数 | 行号 | 说明 |
|---|---|---|
| `getConfig(ctx)` | L91-97 | `ctx.config.get()`，异常回退 `{}` |
| `resolveTopK(ctx, paramTopK)` | L120-129 | 优先级：显式参数 > 实例配置 > 默认 5；越界值落穿下一候选（schema 边界恒被尊重） |
| `resolveLintIntervalMinutes(ctx)` | L139-149 | 配置回退 60，钳制最小 5 |

### 3.2 Wiki 根解析（多公司模型）

每个 Company 一个 wiki，位于其主 workspace 下的 `wiki_path`。

| 函数 | 行号 | 说明 |
|---|---|---|
| `resolveWikiAt(workspacePath, wikiPath)` | L173-181 | 解析候选根：`path.relative` 防目录穿越 + 存在性检查 + `resolvedContainedRoot` |
| `resolveWikiRoot(ctx, companyId, projectId)` | L183-225 | 显式 projectId → 只试该 workspace（找不到不偷看其它项目，尊重槽位上下文意图）；无 projectId → **遍历公司项目（limit 50），接受第一个 workspace 真正包含 wiki 的**（注释解释：真实 Paperclip 会为每个项目合成 workspace，不能停在第一个非空 workspace 上） |
| `resolveWikiRootForIssue(ctx, companyId, issueId)` | L227-244 | 经 `getWorkspaceForIssue` 定位 |

### 3.3 安全模型（symlink 围栏）

| 函数 | 行号 | 说明 |
|---|---|---|
| `isInside(parent, target)` | L86-89 | 词法 `path.relative` 包含检查（挡 `..` 逃逸） |
| `resolvedContainedRoot(workspaceRoot, wikiRoot)` | L256-271 | **wiki 根终审门**：realpath 双端解析，防 wiki 目录本身是指向 workspace 外的 symlink（否则下游所有检查都会锚定在逃逸目标上）；返回规范 realpath |
| `realpathContained(realRoot, target)` | L281-291 | 逐条目防线：realpath 后必须仍在 realRoot 之下（防 wiki 内部 symlink 指向磁盘任意位置） |
| `resolvePageFile(root, slug)` | L293-350 | 按 slug 递归查找 `<slug>.md`（slug 无路径前缀，页面按 basename 全局唯一）；walk 中每条目过 `realpathContained`；候选再次复验（defense in depth） |

### 3.4 数据 provider（8 个）与 agent 工具

均在 `definePlugin({ setup(ctx) })`（L352-719）内注册。所有 handler **永不向宿主抛异常**，错误转为 `{error: ...}` 或空结果：

| Provider | 行号 | 说明 |
|---|---|---|
| `readPage` | L355-382 | slug → 文件 → `{slug, meta, body, links}`。空 slug 短路（L362，防侧栏挂载即全量 walk） |
| `searchWiki` | L385-404 | 空查询短路（L393，防每击键全量 walk）；`collectPages` + `searchSections` → PageRefResult |
| `loadIndex` | L407-462 | 读 `index.md`（可选）+ `indexes/*.md` 分片（逐文件 containment 检查）+ 全页面 slug/title/type 清单 |
| `lintWiki` | L465-496 | 调 `lintWiki(root)`；wiki 不可达返回全零 findings |
| `wikiHealth` | L499-544 | stats + lint 聚合：**fail** = oversizedHard\|malformedFrontmatter\|duplicateSlugs > 0；**warn** = brokenLinks\|orphans\|missingFrontmatter\|oversizedSoft\|stalePages > 0；否则 pass。附 wikiPathMissing 与刷新间隔 |
| `verifySetup` | L547-583 | 安装自检：wiki 可解析性、页数、抽样搜索 "test" 的结果数与耗时 |
| `backlinks` | L586-614 | 指向 slug 的页面（排除自身）；snippet 取首个含该 wikilink 的行，回退首个非空行 |
| `relevantForIssue` | L617-651 | 取 issue（`ctx.issues.get`），query = title+description；搜 topK×2 个分节后**按 slug 去重**取 topK 页 |

| Agent 工具 | 行号 | 说明 |
|---|---|---|
| `wiki.query` | L654-718 | 参数同 manifest；返回 `content`（人类可读行：`- [[slug]] (type) — title § heading`）+ `data.results`（结构化 PageRefResult[]）；wiki 不可达返回 error 内容 |

| 生命周期 | 行号 | 说明 |
|---|---|---|
| `onHealth` | L721-726 | 恒 `{status:"ok"}` — wiki 缺失不该杀死 worker 进程，配置健康由 wikiHealth provider 呈现 |

## 4. `src/lib/` — 四个纯函数库（与 Python 字节级对齐）

### 4.1 `frontmatter.ts`（120 行）

| 导出 | 行号 | 说明 |
|---|---|---|
| `parseFrontmatter(text)` | L57-102 | 与 `wiki_lint.py:46-73` 逐字对齐：`^[a-zA-Z_]+:` 键、引号剥离顺序（先 `"` 后 `'`，L35-46 注释强调顺序依赖）、行内/块列表、不匹配行静默丢弃；返回 `{meta, body, malformed}` |
| `extractWikilinks(body)` | L104-115 | 局部 exec 循环（防模块级 /g 正则的 lastIndex 串扰） |
| `tokenize(text)` | L117-120 | `/[a-z0-9]+/g` 小写化 |

类型：`FrontmatterValue = string | string[]`。

### 4.2 `bm25.ts`（453 行）

文件头（L1-15）声明与 `wiki_search.py` **字节级对齐**：常量 k1=1.5/b=0.75、分词器、IDF 公式、**索引建立在过滤后的集合上**、跳过规则；对齐由 `tests/fixtures/_gen_bm25_expectations.py` 生成的快照 `bm25-expectations.json` 锁定（改算法须重生成快照）。

| 导出/函数 | 行号 | 说明 |
|---|---|---|
| `realpathContained` | L92-102 | symlink 围栏（与 worker 同款，L83-91 注释解释 lstat+realpath 双步理由） |
| `listMarkdownFilesSorted` | L104-164 | 目录名排序遍历 + 逐条 containment；跳过集合：顶层 SCHEMA/index/log 文件 + indexes/graph/raw/.wiki-cache 目录 + 点文件（`shouldSkip` L166-174） |
| `pageFromText` | L185-202 | 文本 → WikiPage（tokens = body+title） |
| `collectPages(wikiRoot)` | L204-219 | 全量收集 |
| `splitSections(title, body)` | L221-272 | 分节切分（多换行符规范化 L232；与 Python 同构的标题栈/代码栅栏逻辑） |
| `buildIndex / score` | L282-304 / L306-323 | BM25 索引（Map 实现）与打分，公式同 Python |
| `searchPages` | L355-381 | 页面级检索（稳定排序注释 L376-377 对齐 Python 的 `sorted(key=-score)`） |
| `searchSections` | L383-427 | 分节级检索；`perPage` 默认 2 的每页限条；同分按收集序 |
| `backlinks / topLinked` | L429-431 / L433-453 | 反链 / 入链 Top-N（Map 插入序保持平局稳定，对齐 Python Counter.most_common；附 broken 标记） |

接口：`WikiPage`（L37-45）、`SearchFilters`（type/tags/since）、`ScoredSection`、`TopLinkedRow`。

### 4.3 `lint.ts`（415 行）

`lintWiki` 与 `wiki_lint.py:119-241` 对齐：同 9 类发现（orphans/brokenLinks/oversizedHard/oversizedSoft/missingFrontmatter/malformedFrontmatter/duplicateSlugs/stalePages/readErrors）、同默认值（软 400/硬 800/陈旧 90 天+入链≥3/必填 fm 五字段）。**`--suggest-pages` 大写短语挖掘有意未移植**（文件头 L16-17，v0.2 视需求）。含同款 realpathContained。

### 4.4 `stats.ts`（262 行）

`computeStats` 与 `wiki_stats.py` 对齐：`StatsResult`（L54-68）含 totalPages/totalLines/totalWords/totalLinks/avgLinesPerPage/avgWordsPerPage/linkDensity/indexLines/pagesByType/pagesByDirectory/largest/mostLinkedIn/**scalingMessages**（阈值消息与 Python L140-151 一致，见文件头 L14-20 注释）。

## 5. `src/ui/` — React 组件体系

`index.tsx`（L17-22）导出 6 个组件，与 manifest 槽位 1:1 对应；另导出 `WikiPageView`（共享视图核心）与 `ErrorBoundary`。

| 组件 | 职责 |
|---|---|
| `WikiSidebar.tsx` | 侧栏：按类型浏览、搜索框（调 searchWiki）、下钻页面 |
| `WikiPage.tsx` / `WikiPageView.tsx` | 全页视图（routePath `llm-wiki`）：Topbar + 左 FolderTree + 中 Reader + 右 PropertiesPanel/OutlinePanel/BacklinksPanel；QuickSwitcher 快速跳转 |
| `WikiContextTab.tsx` | issue 详情页"Wiki context"标签：`usePluginData("relevantForIssue", {companyId, issueId})`（L21-29），空/加载/错误三态 + HostLink 跳 wiki 页 |
| `WikiHealthIndicator.tsx` | 仪表盘健康挂件：四步自检（wiki 已解析 / ≥1 页 / 工具已注册（恒 true）/ lint 通过，L34-41）；徽条 sessionStorage 消失键 `llm-wiki:setup-dismissed`（L27），回归即重现；含刷新（按配置间隔） |
| `page/Reader.tsx` | Markdown 阅读器（WikiMarkdown 渲染）+ landing 态 |
| `page/FolderTree.tsx` / `OutlinePanel.tsx` / `PropertiesPanel.tsx` / `BacklinksPanel.tsx` / `QuickSwitcher.tsx` / `Topbar.tsx` | 目录树 / 当前页大纲 / frontmatter 属性 / 反链（调 backlinks）/ 快速切换 / 顶栏 |
| `WikiMarkdown.tsx` | react-markdown + remark-gfm + rehype-highlight/slug/autolink-headings 渲染 wiki 页 |
| `HostLink.tsx` / `href.ts` / `styles.ts` | 宿主内导航链接 / wikiHref 路由构造 / `injectWikiStyles` 样式注入 |
| `ErrorBoundary.tsx` | 槽位级错误隔离（每个入口组件包裹） |
| `launcher/Launcher.tsx` | 启动器（开发/演示入口） |
| `setup/SetupView.tsx` + `snippets.ts` | 安装引导视图；snippets 中的安装命令片段由 `scripts/check-setup-snippets.mjs` 校验与文档一致 |

## 6. 构建、测试、发布

| 项 | 内容 |
|---|---|
| 构建 | `pnpm build` → esbuild（SDK presets，sourcemap 开、minify 关）三产物 |
| 类型检查 | `pnpm typecheck`（tsc --noEmit） |
| 测试 | `pnpm test`（vitest 3 + @testing-library/react + jsdom；约 30 个 spec：lib 快照对齐、UI 行为、`security/symlinks.spec.ts`、manifest 校验、_smoke） |
| 发布前门禁 | `pnpm prepublish:check`（prepublishOnly 钩子）：typecheck + 测试 + 构建 + manifest/tarball 校验；CI `paperclip-plugin.yml` 在 push/PR 触及插件目录时强制执行 |
| peerDependencies | `@paperclipai/plugin-sdk 2026.428.0`、`react >=18`、`react-dom >=18`（宿主运行时提供，external 化） |

## 7. 与 Python 技能的分工对照

| 维度 | Python 技能（skills/llm-wiki） | Paperclip 插件 |
|---|---|---|
| 角色 | Agent 侧，**读写** | 人类侧，**只读** |
| 检索 | 默认 hybrid（BM25+FastEmbed+RRF） | 仅词法 BM25（与 Python `--no-embed` 字节对齐） |
| 写入 | ingest/lint 修复/synthesis 回填 | 无任何写路径 |
| 依赖 | Python ≥3.10 + uv（PEP 723 隔离） | Paperclip 宿主 + Node 运行时 |
| 一致性保证 | 参考实现 | 快照测试（bm25-expectations.json）锁定与 Python 逐字节一致 |
