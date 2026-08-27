# DSH Work Buddy

DSH Work Buddy 是一个综合性的任务管理与智能体协作平台，集成了任务管理控制台（WorkBuddy-Web）、DeepSeek Harness 智能体组件和 LLM Wiki 文档组件。

- **版本**：`0.1.97`
- **项目标识**：见根目录 [`VERSION`](./VERSION)

---

## 目录结构

```
DSH-WorkBuddy-0.1.97/
├── VERSION                 # 项目顶层版本号
├── README.md               # 本文件
├── start.bat               # 一键启动脚本（Windows，Web + 智能体）
├── start.sh                # 一键启动脚本（macOS / Linux，Web + 智能体）
├── WorkBuddy-Web/          # 任务管理控制台前端 + 一体化服务
├── deepseek-harness/       # 智能体组件（DSH Harness）
├── llm-wiki/               # Wiki 文档组件
└── docs/                   # 项目级文档
```

---

## 组件说明

### 1. WorkBuddy-Web

任务管理控制台前端，提供任务看板、KPI 统计、项目总览、智能体对话等功能。入口文件为单文件 HTML 应用，配合 `server.js` 一体化服务运行。

- **入口文件**：`WorkBuddy-Web/index.html`
- **一体化服务**：`WorkBuddy-Web/server.js`（固定端口 `0.0.0.0:8765`）
- **版本**：`0.1.97`

### 2. deepseek-harness

DeepSeek Harness（DSH）智能体运行框架，提供智能体生命周期管理、工具调用、会话持久化、沙箱安全等能力。

- **主目录**：`deepseek-harness/deepseek-harness-master/`
- **核心脚本**：
  - `npm run build` —— 构建全部库与 Web 产物
  - `npm run dsh` —— 启动 DSH CLI
  - `npm run dev:web` —— 启动 Web 开发模式
  - `npm run test` —— 运行单元测试
- **包管理器**：pnpm 11.7.0
- **Node 版本**：`^22.19.0 || >=24.0.0`

### 3. llm-wiki

VitePress 驱动的 Wiki 文档站点，用于构建和发布 LLM Wiki 文档。

- **主目录**：`llm-wiki/project/`
- **核心脚本**：
  - `pnpm docs:dev` —— 本地预览文档
  - `pnpm docs:build` —— 构建文档站点
  - `pnpm docs:preview` —— 预览构建产物
- **包管理器**：pnpm 10.33.0
- **Node 版本**：`>=20`

---

## 环境要求

| 组件 | 包管理器 | Node 版本 | 备注 |
|------|----------|-----------|------|
| WorkBuddy-Web | 任意静态服务器 | - | 纯前端，可直接用浏览器打开 |
| deepseek-harness | pnpm 11.7.0 | `^22.19.0 \|\| >=24.0.0` | 构建前需先安装依赖 |
| llm-wiki | pnpm 10.33.0 | `>=20` | 构建前需先安装依赖 |

---

## 部署与启动

### 一键启动（推荐）

**Windows**：双击或命令行执行根目录的 `start.bat`：

```bat
start.bat
```

**macOS / Linux**：终端执行根目录的 `start.sh`（首次运行先加执行权限）：

```bash
chmod +x start.sh
./start.sh
```

两个脚本行为等价，自动完成：

1. 检查 Node.js（要求 `^22.19.0 || >=24.0.0`），自动启用 pnpm（corepack / npx 兜底）。
2. 若 `deepseek-harness` 依赖缺失，自动执行 `pnpm install`。
3. 若 `deepseek-harness` 构建产物缺失，自动执行 `pnpm run build`（首次较慢）。
4. 启动一体化服务 `WorkBuddy-Web/server.js`，它会自动拉起 dsh 智能体服务并打开浏览器。

**固定端口**：

- Web 控制台：`http://127.0.0.1:8765`（固定，不漂移）
- dsh 智能体服务：`http://127.0.0.1:3080`（内部固定，由 server.js 自动拉起并代理）

> `server.js` 同时提供：静态文件服务（含视频 Range 支持）、本地业务 API、`/harness/` 同源代理、智能体 RPC 转发与 WebSocket 桥接。启动 Web 即自动拉起智能体，任务界面中的智能体对话窗口即可使用。

### 手动启动

**WorkBuddy-Web（任务管理控制台 + 智能体）**

```bash
cd WorkBuddy-Web
node server.js
# 访问 http://127.0.0.1:8765
```

**deepseek-harness（智能体组件，独立运行）**

```bash
cd deepseek-harness/deepseek-harness-master
pnpm install
pnpm run build
pnpm dsh web
# 独立访问 http://127.0.0.1:3080
```

**llm-wiki（Wiki 文档组件）**

```bash
cd llm-wiki/project
pnpm install
pnpm docs:build
pnpm docs:preview
```

---

## 打包说明

本项目分发包为根目录下的：

```
DSH-WorkBuddy-0.1.97.zip
```

该压缩包已排除以下内容：

- `.trae/` 开发计划与临时文档
- `.git/` 版本控制目录
- `node_modules/` 依赖目录
- `__pycache__/`, `.pytest_cache/`
- `dist/`, `build/`, `lib/` 等构建产物
- `.log`, `.tmp` 等临时文件

如需重新打包，请确保先清理各组件构建产物与运行时数据，再生成压缩包。

---

## 版本策略

- 整个 DSH Work Buddy 项目对外版本为 `0.1.97`（见 `VERSION`）。
- `WorkBuddy-Web` 的 `package.json` 版本同步为 `0.1.97`。
- `deepseek-harness`、`llm-wiki` 等组件保留其自身原有版本，不强制统一。

### v0.1.97 更新要点

- **本地模型（Qwen3.8）通用兼容模式多方实测通过**：使用设置中心添加的本地 Qwen3.8 端点（`qwen` provider，`openai-responses`）在通用兼容模式下完成全链路验证——协议自动适配（`/api/probe-responses` 判定 Respons 支持）、会话模型选择（`session.models`/`session.selectModel`）、图片模态判定（`/api/model-modality` → `image=true`）、工具面装配（pwsh/grep/glob/web_search/skill/str_replace_editor）、真实工具调用（pwsh `Get-Location`、grep 搜索均产生 `tool/result`）共 26 项全部通过（`_test_probe_qwen_universal.mjs`）。
- **协议探测超时延长至 30s**：`/api/probe-responses` 探测超时由 6s 提升至 30s，覆盖慢速本地端点冷启动（如 27B 本地大模型首请求加载 >6s）导致的探测误判，确保「Responses 优先 + Completions 兜底」协议自动适配在本地大模型场景下准确判定。

### v0.1.96 更新要点

- **通用兼容模式升级：Responses API 优先 + Completions 兜底**：自定义 Provider 表单新增「自动适配」协议选项（默认），保存/获取模型时先经网关 `POST /api/probe-responses` 探测远端端点是否支持 OpenAI Responses API——支持则按 `openai-responses` 配置，不支持则自动回退 `openai-completions`，探测不可达时默认按 Responses 配置；提升智能体在通用兼容模式下执行任务、交换数据、调度工具的能力。
- **空密钥本地端点兜底**：自定义 Provider 密钥留空时不再声明 `apiKeyEnv`（避免 harness 抛 MISSING_CREDENTIAL），改为注入占位 `Authorization: Bearer local` 头，本地 vLLM / llama.cpp / ollama 等无需密钥端点可直接启用。
- **协议探测接口**：网关新增 `/api/probe-responses`（POST `{baseURL, model?}` → `{supported, status, note}`），404 区分「模型不存在（路由存在）」与「路由不存在」，为协议自适应提供准确依据。

### v0.1.95 更新要点

- **数据存储加固（本地业务数据）**：插件社区收藏、归档组清单、智能体模板清单统一迁移到版本化信封（`{version, updatedAt, data}`）+ 原子写入（临时文件替换 + `.bak` 备份）的持久化方案（`modules/datastore.js`），旧裸数组格式自动迁移、损坏 JSON 回退兜底，彻底避免半写入损坏；数据目录支持 `DSH_WB_DATA_DIR` 环境变量覆盖（默认 `data/`）。
- **接口诚实返回（清理「假成功」）**：工作区文件接口 `GET /api/workspaces/<id>/files` 改为真实扫描工作区目录（最深 4 层，跳过隐藏文件与 node_modules），不存在的工作区返回 `404 workspace-not-found`；插件/技能启停接口统一返回 `501 not-implemented`；不存在的智能体模板 PUT/DELETE 返回 `404 template-not-found`，前端不再被「假成功」误导。
- **导航路由拆分**：hash 路由与页面切换逻辑从 `index.html` 拆分为独立模块 `modules/navigation.js`（页面行为不变），便于维护；网关新增 `/modules/` 静态托管。

### v0.1.9 更新要点

- **通用兼容模式补齐基础工具面**：文件搜索（grep/glob，ripgrep 跨平台）+ 网络搜索（web_search，web_fetch 关闭）+ Windows 下 pwsh 终端（POSIX 保持持久 bash），全部复用 harness 既有工具，零新增依赖。
- **第三方模型工具调用质量优化（openai-responses (Responses) 模式）**：通用兼容 preset 的 persona 加入工具调用纪律（必填参数补全、参数错误修正后重试一次、不循环重试），显著提升第三方/本地模型在 Responses 模式下执行任务与处理长文本的稳定性与工具调用成功率；配合前端工具连续失败护栏（≥3 次拦截并取消回合），避免失控循环。

### v0.1.8 更新要点

- **第三方/自定义大模型**：支持非 DeepSeek 第三方与本地 API 模型（设置中心内置供应商目录 40+ 家，含本地 vLLM / llama.cpp / ollama 等 OpenAI 兼容端点）。
- **新模式-通用兼容**：新增「通用兼容」工作模式，专为非 DeepSeek 第三方/本地模型设计，装配终端 + 文件编辑 + 技能（llm-wiki 等可用），兼容性最好；第三方模型下自动/手动切换有权限护栏提示。

### v0.1.7 更新要点

- **跨平台**：支持 macOS / Linux 运行（`start.sh` 一键启动；网关优雅关闭平台分支）。
- **智能体管理**：模板删除彻底生效（定义 + 记忆目录一并清除）；对话后重启不再出现「被找回」的 seed 预置模板。
- **文件归档**：归档弹窗文件列表包含任务目录全部文件（含 AGENTS.md / MEMORY.md / task.json），仅排除隐藏文件。
- **智能详情面板**：补齐标签、会话创建时间、对话轮数、会话文件数；移除冗余的「创建于/完成于」描述行。
- **工作区卡片**：支持可选渐变色背景（8 个预制渐变，localStorage 持久化）。
- **Wiki 知识图谱**：严格按仓库隔离，不同仓库文档不再错误关联。

---

## 注意事项

1. 首次启动请使用根目录 `start.bat`（Windows）或 `start.sh`（macOS / Linux）一键启动，它会自动安装依赖、构建并同时启动 Web 与智能体服务。
2. Web 控制台固定端口为 `127.0.0.1:8765`，智能体服务内部固定为 `127.0.0.1:3080`；若端口被占用请先关闭旧实例。
3. `deepseek-harness` 依赖 Node `^22.19.0 || >=24.0.0`，请确认环境版本符合要求。
4. 平台支持：Windows / macOS / Linux 均可运行。智能体沙箱按平台自动选择（Windows 无沙箱、Linux 用 landlock/bwrap、macOS 用系统 seatbelt）；网关优雅关闭在 Windows 用 `taskkill` 杀进程树、其他平台用 `SIGKILL` 兜底。
5. 智能体真实对话需要 DeepSeek API Key，请通过环境变量 `DEEPSEEK_API_KEY` 或控制台「设置中心 → DeepSeek 大模型配置」配置；本仓库不包含任何真实密钥。
6. 视频背景文件位于 `WorkBuddy-Web/card-bg/`，播放速度已在 `index.html` 中设置为 0.5 倍。
