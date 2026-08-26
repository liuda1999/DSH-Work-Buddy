# AGENTS.md — DSH Work Buddy 项目指南与运维手册

> 本文件是智能体读取的项目总纲：项目是什么、由哪些组件构成、每部分如何运作、如何启动与运维。
> 项目版本：**v0.1.95**（见根目录 `VERSION`）。修改本项目时请先阅读本节与对应模块章节，遵循末尾「项目约定」。

---

## 1. 项目概述

**DSH Work Buddy** 是一个综合性的任务管理与智能体协作平台。它不是一个单纯的前端 Web 项目，而是由**三个紧密耦合的组件 + 技能**组成的整体，启动/关闭必须同进同退：

| 组件 | 目录 | 端口/形态 | 角色 |
|---|---|---|---|
| **WorkBuddy-Web** | `WorkBuddy-Web/` | `0.0.0.0:8765`，一体化网关进程（默认监听所有网卡，支持同局域网跨设备访问） | 前端控制台（8 个页面）+ 本地业务 API + RPC 转发 + WS 桥 + 静态托管 + 组件拉起/自愈/优雅关闭 |
| **deepseek-harness** | `deepseek-harness/deepseek-harness-master/` | `127.0.0.1:3080`，**由网关 spawn 的子进程** | dsh 智能体运行框架（会话/模型/权限/命令/技能/插件运行时） |
| **llm-wiki** | `llm-wiki/project/` | 静态构建产物，由网关在 `/llm-wiki-plugin/` 托管 | VitePress 文档库（智能体知识库），无独立进程 |
| **技能** | `.dsh/skills/llm-wiki/` | 文件 | llm-wiki 技能（SKILL.md + 脚本），网关启动时幂等安装 |

**核心链路**：`start.bat`（Windows）/ `start.sh`（macOS/Linux）→ `node server.js`（网关 8765）→ 自动拉起 dsh 智能体（3080，子进程）、检查 Wiki 构建产物、安装技能。关闭网关时所有组件一起关闭（优雅关闭，不留孤儿进程；Windows 用 taskkill 杀进程树、其他平台 SIGKILL 兜底）。

---

## 2. 目录结构

```
e:\worke
├── VERSION                 # 项目顶层版本号（当前 0.1.95）
├── README.md               # 对外说明
├── start.bat               # 一键启动（Windows）：依赖/构建（幂等）→ 端口检查 → 启动 Web + 拉起智能体
├── start.sh                # 一键启动（macOS/Linux）：等价 bash 逻辑，首次运行先 chmod +x
├── AGENTS.md               # 本文件
├── .gitignore              # 忽略 data/ node_modules/ 测试脚本/凭证等
├── .dsh/skills/llm-wiki/   # llm-wiki 技能（SKILL.md + references + scripts，已入库）
├── WorkBuddy-Web/          # 主应用（唯一需要直接维护的前后端）
│   ├── index.html          # 前端单页（内联 CSS/JS，约 10k 行，全部 8 个页面）
│   ├── server.js           # 一体化网关（本地 API + RPC 转发 + WS + 托管 + 拉起/关闭）
│   ├── package.json        # 版本号（与 VERSION 同步）
│   ├── data/               # 运行时数据（不入库）：tasks/ wiki/ archive/ workspaces/ agents/
│   └── _test_*.mjs 等      # 验证/诊断脚本（不入库，见运维手册）
├── deepseek-harness/deepseek-harness-master/  # dsh 智能体框架（第三方源码，**不改**）
└── llm-wiki/project/       # VitePress 文档库（第三方源码 + 构建产物，**不改**）
```

---

## 3. 前端页面与功能（WorkBuddy-Web/index.html，8 个页面）

| 页面 | data-page | 功能 |
|---|---|---|
| **导航路由** | 全局 | **hash 路由**：切页更新 URL（`#/tasks` 等），刷新/前进后退回到对应页；「团队协作」为占位项（不切换） |
| **任务管理** | `tasks` | 任务看板（今日/进行中/已完成/逾期分组）、KPI 与环比、左侧工作区侧栏（含各工作区任务数徽标）、点击任务打开**会话弹窗**（自研对话组件：输入栏 + 文件/图片上传 + 模型/模式/权限 chips + 斜杠命令 + 只读拦截条 + 设定新期限） |
| **项目总览** | `overview` | 全工作区任务统计、分区概览、搜索；「查看文件」玻璃抽屉 |
| **文件归档** | `archive` | 归档组管理 + 归档会话卡片（文件大小 MB / Token 万/亿，两位小数）；点卡片打开详情弹窗（左：按扩展名分类的文件列表，可预览/下载；右：对话记录） |
| **日程管理** | `schedule` | 日程/待办视图 |
| **团队协作** | `team` | 占位（敬请期待） |
| **资源仓库** | `resources` | Tab：插件（dsh 实时清单，只读）、技能、智能体身份、Wiki 知识库（**分类 > 仓库 > 文档三级结构**：新建仓库/新建文档归仓/编辑移动仓库 + 增删检索 + **知识图谱**：文档+章节节点、跨文档引用） |
| **插件社区** | `plugin-community` | 网址导航瀑布流：**9 个预置精选社区**（含 dsh-plugin 专题、Hugging Face、魔搭等，不可删）+ 用户自建收藏（可删） |
| **设置中心** | `settings` | 大模型 API 配置：DeepSeek 官方卡、默认模型卡、插件与运行时卡（shell/agent-loop/web-search 分级档位）、**内置供应商目录**（40+ 家 catalog，配置密钥即启用）、**自定义 Provider**（本地 vLLM/llama.cpp/ollama OpenAI 兼容端点 + 「获取模型」按钮 + 编辑）、高级命名空间动态表单 |

### 会话弹窗（核心交互）
- 会话与任务一对一绑定，绑定持久化在 `task.sessionSnapshot`（重进复用同一会话，历史保留）。
- 对话组件直连 dsh：`session.models`（模型选择器，含「⟳ 刷新」）、`agentPreset.list`（工作模式，含**通用兼容**模式：面向非 DeepSeek 第三方/本地模型，装配终端（POSIX 持久 bash / Windows pwsh）/文件编辑/文件搜索/网络搜索/tool-skill，本地文件系统无沙箱；第三方模型下自动/手动切换有权限护栏）、`session.history` 投影（权限级别 / 上下文卡 / 统计卡）。
- **附件上传**：📎 文件按钮（文本类文件，文本块注入发送，所有模型可用）+ 🖼️ 图片按钮（**仅支持图片输入的模型显示**，经网关 `/api/model-modality` 判定：settings 声明 > pi-ai 内置目录 > provider defaultInput）；选择后附件即保存到任务专属目录 `uploads/`（会话隔离、重名加序号、防穿越），chip 显示已保存标记。
- 逾期/已完成任务只读（输入封禁 + 拦截条）；逾期任务可「设定新期限」恢复会话（renew 重算状态 + 重开非只读对话组件）。

---

## 4. 后端服务模块（WorkBuddy-Web/server.js）

单文件一体化网关，按职责划分：

1. **本地业务 API**（不转发 dsh）：`/api/workspaces`、`/api/tasks`、`/api/archive`、`/api/wiki`、`/api/resources`、`/api/schedule`、`/api/search`、`/api/plugin-community`。
   - 任务：内存 db + **磁盘持久化**（`data/tasks/<id>/task.json`，重启恢复）；任务专属目录 = 会话隔离边界；对话附件落盘 `<任务目录>/uploads/`（`POST /api/tasks/<id>/upload`，文件名消毒防穿越、重名加序号、16MB 上限）。
   - 归档：复制产物到 `data/archive/<组>/<任务>_<id后6位>/` + `manifest.json`（元数据 + 对话记录 + 文件清单）。
   - Wiki 知识库：**仓库清单持久化**（`data/wiki/repos.json`，内置「本地文档库」恒在；`GET/POST /api/wiki/repos` 建仓）；文档**归仓落盘**（lite 模式 `data/wiki/<仓库>/<标题>.md`，llm-wiki 模式 `sources/`；`POST /api/wiki/write` 新建、`PUT /api/wiki/doc` 编辑可移动仓库并清理旧文件）；listWikiDocs 按目录推断 category/repoSlug。
   - Wiki 图谱：扫描文档构建 document/section 节点 + contains/part_of/mentions 边，按「文档集合指纹」自动失效重建，图数据按 (category, repo) 隔离。
   - 模型模态判定：`GET /api/model-modality?provider=&model=` → `{image}`（对话窗口图片按钮显隐依据）。
   - 插件社区：`{presets: 预置 9 项, user: 自建收藏}`；**用户收藏落盘**（`data/plugin-community.json`，重启恢复）。
   - 归档：组定位兼容 **id 或 name**（前端下拉提交组名）；归档会话落盘 `<组>/<任务>_<id后6位>/`。
   - 任务：`agentTemplate`（智能体身份）随 PATCH 持久化 `task.json`，重启恢复；前端关闭弹窗重开经 openSessionModal/renderSwAgentCard 双层兜底同步最新身份。
2. **RPC 转发**（`/api/<method>` → harness 3080，envelope `{type:'client-request', rpcId, method, payload}`）：`session.*`、`workspace.*`、`llm.*`、`credentials.*`、`settings.*`、`agentPreset.*`、`skill.*`、`commands.*` 等全量透传。
   - **必须改写 Origin 头为 `http://127.0.0.1:3080`**（dsh 连接围栏要求 Origin 与 Host 匹配，否则 403）。
3. **WS 桥**：`/api/events.mux`（会话事件流，Origin 同样改写）。
4. **静态托管**：`/llm-wiki-plugin/`（Wiki 构建产物）、`/`（index.html）、`/logo.jpg` 等；`/harness/*` 反代 dsh web。
5. **组件生命周期**：
   - 启动：`ensureHarness()`（探测 3080 → 未运行则 spawn 拉起，`--port/--host` 随配置）、`ensureWiki()`（构建产物检查）、`ensureSkills()`（技能幂等安装）。
   - **优雅关闭**：`SIGINT/SIGTERM` → 关 http server → 销毁 WS 连接 → 杀智能体子进程（SIGTERM → taskkill /T /F 兜底）→ 3s 强制退出；`exit` 钩子同步兜底 kill。**组件同关，不留孤儿**。
   - **自愈**：`reviveHarness()`（RPC 失败时冷却 10s 自动拉起，配合前端 waitHarnessReady 轮询）。
   - `server.on('error')`：端口占用友好中文提示并退出。
   - 端口/主机可配：`DSH_WB_HOST`（默认 `0.0.0.0`，同局域网访问；改 `127.0.0.1` 则仅本机）、`DSH_WB_PORT`（默认 `8765`）；`DSH_WB_HARNESS_HOST`（默认 `127.0.0.1`，不建议改，3080 由网关反代）、`DSH_WB_HARNESS_PORT`（默认 `3080`）。启动日志会自动打印本机 IPv4 对应的访问地址，Windows 首次被访问时需在防火墙弹窗选择"允许"（放行 8765 入站）。

---

## 5. 智能体组件交互契约（deepseek-harness，**不改源码**）

- 一切交互经网关 8765 转发；禁止直接改 `deepseek-harness/` 或 `llm-wiki/project/` 下任何源码。
- 会话建立：`workspace.create(path=任务目录)` → `session.create(workspaceId)` → 前端 PATCH `bindSession` 回写 `sessionSnapshot`。
- 会话级模型/权限：`session.models`、`session.selectModel`、`session.history`（projections.permissions / tokenUsage / sessionStats / contextPressure）。
- 命令通道：`commands/list` + `commands/execute`（不是 session.prompt 发 `/` 文本）。
- 凭证体系：`credentials.set/unset/describe` → 落 `~/.dsh/.credentials.yaml`（项目树外唯一存储）。
- 设置体系：`settings.describe` + `settings.mutate`（命名空间 `llm-deepseek` / `agent-default-model` / `llm-pi-ai` / `shell` / `agent-loop` / `web-search-deepseek` 等）。
- 模型 Provider：`llm-pi-ai.providers.<route>`（catalog 40+ 家，`apiKeyEnv` + 可选 `baseURL/models`）；自定义/本地端点走 `openai-completions` + 本地 Base URL。

---

## 6. 数据与凭证安全

- `WorkBuddy-Web/data/` 是运行时数据（任务/归档/图谱/Wiki），**不入库**（.gitignore）；打包前须清理。
- **API 凭证唯一合法存储 = 设置中心**（dsh credentials → `~/.dsh/.credentials.yaml`，项目树外）。项目树内禁止 `.env`、密钥字面量、注册表存放 DEEPSEEK_API_KEY。
- 打包前必须运行 `WorkBuddy-Web/_sanitize_check.mjs`，全部 PASS 才允许打包（检查：旁路凭证文件、密钥字面量、运行时数据、注册表、受管凭证提示）。

---

## 7. 运维手册

### 7.1 启动
```bat
start.bat        # Windows：依赖/构建（首次较慢，幂等）→ 端口检查 → 启动 Web 并拉起智能体
./start.sh       # macOS/Linux：等价逻辑（bash），首次运行先 chmod +x start.sh
```
或直接：`cd WorkBuddy-Web && node server.js`（自动拉起智能体 3080 + 检查 Wiki + 安装技能）。
就绪标志：网关日志出现「dsh 智能体服务就绪」「Wiki 文档库就位」；本机访问 `http://127.0.0.1:8765`；同局域网跨设备访问 `http://<本机IPv4>:8765`（如 `http://192.168.0.100:8765`，启动日志中已列出）。

> **start.bat 编码要求（重要）**：批处理必须以 **UTF-8 BOM + CRLF 换行**保存（.gitattributes 已强制 `*.bat eol=crlf`）。
> 若文件被保存为无 BOM UTF-8 或 LF 换行，中文 Windows（GBK 代码页）下 cmd 解析会行错乱
> （`xxx is not recognized as an internal or external command`、banner 乱码），启动直接失败。
> 修改 start.bat 后请用 `node -e "..."` 或编辑器以 UTF-8 BOM + CRLF 保存，勿用 LF。

### 7.2 关闭
- 在启动终端按 `Ctrl+C`（或结束 `node server.js`）：网关与智能体子进程**同步关闭**，端口 8765/3080 一并释放。
- 若残留孤儿 3080（异常强杀）：启动新实例会提示「检测到外部/遗留智能体实例」，此时 `taskkill /F /PID <pid>` 或重启机器清理。

### 7.3 验证/回归脚本（`WorkBuddy-Web/_*.mjs`，均不入库）
| 脚本 | 用途 |
|---|---|
| `_test_startup_qc.mjs` | 启动质检 17 项（网关/智能体/Wiki 同时就位） |
| `_test_e2e_chat.mjs` | 真实对话 E2E 18 项 |
| `_test_smoke_dom.mjs` | 前端加载期 JS 错误检查 |
| `_test_diag_revive.mjs` | 智能体崩溃自愈全真验证 |
| `_test_diag_shutdown.mjs` | 优雅关闭验证（组件同关、无残留进程） |
| `_test_verify_v2.mjs` / `_test_verify_chat.mjs` / `_test_verify_perm.mjs` / `_test_verify_p2/p3b/p4.mjs` | 功能回归套件 |
| `_test_probe_*.mjs` | 功能实证探针（图谱/设置中心/归档/插件社区/卡片格式等） |
| `_test_probe_upload.mjs` | 对话上传探针（模态显隐 6 项 + 文件附件 14 项 + 后端模态 6 项 + 落盘隔离 11 项） |
| `_test_probe_agent_delete.mjs` | 智能体模板删除不复活（DELETE 同步删记忆目录 + 孤儿扫描不捞回，7/7） |
| `_test_probe_agent_seed_recover.mjs` | seed 预置目录（tpl-preset-*）孤儿找回排除验证（6/6） |
| `_test_probe_archive_files2.mjs` | 归档文件列表含系统档案（AGENTS.md/MEMORY.md/task.json）+ 隐藏文件排除（13/13） |
| `_test_probe_detail_panel.mjs` | 智能详情面板字段修复（label 持久化/fileCount/openedAt/轮数链路，7/7） |
| `_test_probe_wiki_graph_isolate.mjs` | Wiki 知识图谱仓库隔离（节点无交集、无跨仓库边，5/5） |
| `_test_probe_wiki_repo.mjs` / `_test_probe_wiki_pane.mjs` / `_test_probe_wiki_empty_repo.mjs` | WIKI 建仓/归仓/编辑移动/空仓库卡片探针 |
| `_test_probe_wiki_repo_delete.mjs` | WIKI 仓库删除 + 仓库间隔离（文档/目录/图谱隔离，默认仓库保护，15/15） |
| `_test_probe_wiki_repo_del_ui.mjs` | 仓库删除按钮渲染 + deleteRsRepo 契约（vm，6/6） |
| `_test_probe_modality_custom.mjs` | 自定义 Provider 模态声明（真实写入→查询→清理） |
| `_test_probe_agent_bind/ui/fallback.mjs` | 智能体身份持久化链路 + 关闭重开渲染 + 兜底同步 |
| `_test_probe_archive_group.mjs` | 归档组修复（按 name/id 落盘到指定组，非默认组） |
| `_test_probe_nav.mjs` | 导航 hash 路由（URL 变化 + 刷新恢复） |
| `_test_probe_misc.mjs` | 插件社区增删 + 工作区创建/删除链路 |
| `_audit_ui.mjs` | 静态审计：事件块网络请求/加载态/错误提示扫描 |
| `_sanitize_check.mjs` | 打包前脱敏检查（必跑） |

回归基线：startup_qc 17/17、e2e_chat 18/18、smoke、verify_v2 25/25 等全部通过。

### 7.4 常见故障排查
- **start.bat 报 `xxx is not recognized` 或中文乱码**：文件被存成无 BOM UTF-8 / LF 换行。用 UTF-8 BOM + CRLF 重新保存（或 `git checkout -- start.bat` 恢复）。
- **首次启动安装依赖失败**：pnpm 不在 PATH 时走 corepack / `npx pnpm@11.7.0` 兜底（需网络）；确保网络可用或先手动 `corepack enable`。
- **端口 8765 被占**：网关启动即报「端口已被占用」并退出 → 关闭旧实例。
- **局域网访问 8765 不通（浏览器 ERR_CONNECTION_REFUSED / 超时）**：
  1. 确认启动日志含「已允许同局域网跨设备访问」且绑定 `0.0.0.0:8765`；如仍监听 `127.0.0.1`，设置环境变量 `DSH_WB_HOST=0.0.0.0` 重启。
  2. Windows：检查「高级安全 Windows Defender 防火墙 → 入站规则」是否放行 `node.exe` / 8765 端口；或首次访问时弹出的防火墙对话框点击「允许访问 → 专用网络」。可临时用管理员 PowerShell 加规则：`New-NetFirewallRule -DisplayName "DSH Work Buddy 8765" -Direction Inbound -Protocol TCP -LocalPort 8765 -Action Allow`。
  3. 确认两台设备处于同一子网（同网段 IP / 同一 Wi-Fi；不跨 VLAN / VPN），本机 IPv4 与客户端能互相 `ping` 通。
  4. 服务器本机先用 `curl http://127.0.0.1:8765/` 验证站点有响应，再在客户端用 `curl http://<本机IPv4>:8765/` 验证，必要时 `netstat -ano | findstr :8765` 确认 `LISTENING` 在 `0.0.0.0`。
- **仍想仅本机访问**：`set DSH_WB_HOST=127.0.0.1`（Windows）或 `export DSH_WB_HOST=127.0.0.1`（*nix）后再启动即可回到仅回环访问。
- **端口 3080 被占（孤儿/外部）**：网关日志提示复用；若实例异常，清理 3080 后重启。
- **对话弹窗提示「智能体未连接/等待服务启动」**：网关 RPC 失败会触发自愈拉起（约 10s 冷却），前端 waitHarnessReady 轮询等待；仍失败查 `node server.js` 终端日志。
- **模型不可用/目录为空**：设置中心检查 Provider 凭证（`credentials.describe`）与默认模型；对话模型弹层点「⟳ 刷新」。
- **知识图谱为空/过期**：图谱按文档集合指纹自动重建；`POST /api/wiki/graph` 可强制重建。
- **测试需隔离环境**：用 `DSH_WB_PORT` / `DSH_WB_HARNESS_PORT` / `DSH_HOME` 起第二个实例（不影响现网）。

### 7.5 版本升级
版本号同步修改 5 处：`VERSION`、`WorkBuddy-Web/package.json`、`start.bat`（v 前缀 banner）、`start.sh`（v 前缀 banner）、`README.md`（版本/目录/分发包名/版本策略）。提交 git：`git add` 相关文件后 commit。

---

## 8. 项目约定（必须遵守）

1. **不改 `deepseek-harness/`、`llm-wiki/project/` 任何源码**；一切交互经网关 8765。
2. 网关转发必须改写 Origin 为 `http://127.0.0.1:3080`（Origin 围栏，403 排查点）。
3. API 凭证唯一合法存储 = 设置中心（`~/.dsh/.credentials.yaml`）；项目树内禁止旁路凭证。
4. 打包前必跑 `_sanitize_check.mjs` 且全部 PASS。
5. `data/`、`_*.mjs`、`_p3_marker.json`、`.trae/`、`*.zip` 不入库（.gitignore 已覆盖）。
6. 任务数据为内存 db + `task.json` 落盘（重启恢复）；任务专属目录是会话隔离边界。
7. 新功能改动须配验证脚本（`_test_probe_*.mjs` 实证 + 回归套件），修复必须用真实测试结果确认。
8. 对话窗口、设置中心、归档页的统计单位与字段契约（如 detail 返回 `categories`、plugin-community 返回 `{presets,user}`）改动时须前后端同步。
