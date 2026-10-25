# DSH Work Buddy

DSH Work Buddy 是一个综合性的任务管理与智能体协作平台，集成了任务管理控制台（WorkBuddy-Web）、DeepSeek Harness 智能体组件和 LLM Wiki 文档组件。

- **版本**：`0.4.2`
- **项目标识**：见根目录 [`VERSION`](./VERSION)

---

## 目录结构

```
DSH-WorkBuddy/
├── VERSION                 # 项目顶层版本号
├── README.md               # 本文件
├── start.bat               # 一键启动脚本（Windows，Web + 智能体）
├── start.sh                # 一键启动脚本（macOS / Linux，Web + 智能体）
├── WorkBuddy-Web/          # 任务管理控制台前端 + 一体化服务（含移动端 m.html）
├── deploy/                 # systemd 服务版本受控部署（unit 模板 + 包装脚本 + 幂等安装器）
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
- **版本**：`0.4.2`
- **核心能力**：任务看板与 KPI、项目总览、文件归档、日程管理、资源仓库（插件/技能/智能体管理/**MCP 管理**/Wiki 知识图谱）、插件社区、设置中心（40+ 供应商与本地模型）；**移动端竖屏界面**（`m.html`：手机访问自动切换，任务首页 + 智能体对话，`?desktop=1` 强制桌面版）；用户级智能体预设（standard-fix / universal，含上下文压缩体系与 MCP 组合同步）、幽灵工作区展示过滤与启动自愈清扫、systemd 服务版本受控部署（`deploy/`）、局域网访问（`http://<内网IP>:8765`）

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
| llm-wiki | pnpm 10.33.0 | `>=20` | 构建前需先安装依赖；**需安装 Git**（VitePress lastUpdated 功能依赖） |

---


> **📌 前置检查**：请确保已安装 [Git](https://git-scm.com/download/win)，否则 Wiki 文档库构建会失败。
> （安装后重启终端或重新打开命令行，确保 `git --version` 能输出版本号）

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
DSH-WorkBuddy-<VERSION>.zip   # 如 DSH-WorkBuddy-0.4.2.zip
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

## 注意事项

1. 首次启动请使用根目录 `start.bat`（Windows）或 `start.sh`（macOS / Linux）一键启动，它会自动安装依赖、构建并同时启动 Web 与智能体服务。
2. Web 控制台固定端口为 `127.0.0.1:8765`，智能体服务内部固定为 `127.0.0.1:3080`；若端口被占用请先关闭旧实例。
3. `deepseek-harness` 依赖 Node `^22.19.0 || >=24.0.0`，请确认环境版本符合要求。
4. 平台支持：Windows / macOS / Linux 均可运行。智能体沙箱按平台自动选择（Windows 无沙箱、Linux 用 landlock/bwrap、macOS 用系统 seatbelt）；网关优雅关闭在 Windows 用 `taskkill` 杀进程树、其他平台用 `SIGKILL` 兜底。
5. 智能体真实对话需要 DeepSeek API Key，请通过环境变量 `DEEPSEEK_API_KEY` 或控制台「设置中心 → DeepSeek 大模型配置」配置；本仓库不包含任何真实密钥。
6. 视频背景文件位于 `WorkBuddy-Web/card-bg/`，播放速度已在 `index.html` 中设置为 0.5 倍。
7. Wiki 检索为**词法 BM25**（`wiki_search.py --no-embed` 与网关 `/api/wiki/search`）：FastEmbed 语义检索因内网无法下载嵌入模型而降级，属既定现状——本地轻量文本数据暂不需要语义检索；资源仓库「知识图谱」不受影响（基于磁盘文档真实提取）。
