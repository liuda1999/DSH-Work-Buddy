// DSH Work Buddy 一体化服务：固定端口 8765，随启动自动拉起 dsh 智能体（127.0.0.1:3080），
// 并提供 /harness/ 同源代理、RPC 转发、WebSocket 桥接、本地业务 mock 与静态文件服务。
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { openJsonStore, atomicWriteJson, resolveInside } = require('./modules/datastore');

const HOST = process.env.DSH_WB_HOST || '0.0.0.0';
const PORT = Number(process.env.DSH_WB_PORT || 8765);
// dsh 智能体默认仅本机回环监听即可（外部访问统一经 8765 网关反代，自带 Origin 围栏改写）。
// 若确实需要直连 3080，可显式设置 DSH_WB_HARNESS_HOST=0.0.0.0（不推荐，会绕过网关鉴权链路）。
const HARNESS_HOST = process.env.DSH_WB_HARNESS_HOST || '127.0.0.1';
const HARNESS_PORT = Number(process.env.DSH_WB_HARNESS_PORT || 3080);
const HARNESS_DIR = path.resolve(__dirname, '..', 'deepseek-harness', 'deepseek-harness-master');
const HARNESS_START_CMD = ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web'];
// Wiki 文档库（llm-wiki VitePress 构建产物；站点 base=/llm-wiki-plugin/，网关按该前缀静态托管）
const WIKI_BASE = '/llm-wiki-plugin/';
const WIKI_DIST = path.resolve(__dirname, '..', 'llm-wiki', 'project', 'docs', '.vitepress', 'dist');
// dsh 技能安装源/目标（dsh 从 <项目根>/.dsh/skills/<name>/SKILL.md 扫描技能，项目根即 e:\worke）
const SKILL_SRC_DIR = path.resolve(__dirname, '..', 'llm-wiki', 'project', 'skills', 'llm-wiki');
const SKILL_DST_DIR = path.resolve(__dirname, '..', '.dsh', 'skills', 'llm-wiki');
const HARNESS_READY_TIMEOUT_MS = 60000;
const HARNESS_PROBE_INTERVAL_MS = 2000;
const HARNESS_PROBE_TIMEOUT_MS = 1500;

let harnessProcess = null;
let harnessUp = false;
let harnessBooting = false;   // 拉起轮询中（防重复 spawn）

// 获取本机非回环 IPv4 地址列表（用于启动日志中提示局域网访问地址）
function getLanIpv4List() {
  const result = [];
  try {
    const nifs = os.networkInterfaces();
    for (const [name, list] of Object.entries(nifs)) {
      if (!list) continue;
      for (const n of list) {
        if (n.family !== 'IPv4' || n.internal) continue;
        result.push({ name, address: n.address });
      }
    }
  } catch (e) { /* ignore */ }
  return result;
}
function formatBindUrls() {
  const primary = (HOST === '0.0.0.0' || HOST === '::') ? '127.0.0.1' : HOST;
  const lines = [`http://${primary}:${PORT}`];
  if (HOST === '0.0.0.0' || HOST === '::') {
    for (const n of getLanIpv4List()) lines.push(`http://${n.address}:${PORT}  (${n.name})`);
  }
  return lines;
}

// ---------- 数据目录（用户工作区根 / 任务专属目录） ----------
// 支持 DSH_WB_DATA_DIR 覆盖（测试/迁移隔离用，默认项目内 data/）
const DATA_DIR = path.resolve(process.env.DSH_WB_DATA_DIR || path.join(__dirname, 'data'));
const WS_DATA_DIR = path.join(DATA_DIR, 'workspaces');
const TASK_DATA_DIR = path.join(DATA_DIR, 'tasks');
// 智能体内置记忆库：按模板 id 分目录存放 MEMORY.md（长期画像，跨任务沉淀）
const AGENTS_DATA_DIR = path.join(DATA_DIR, 'agents');
// Wiki 轻量文档库（lite 模式存储根目录）与 llm-wiki 模式数据目录
const WIKI_STORE_DIR = path.join(DATA_DIR, 'wiki');
const WIKI_LLM_DIR = path.join(DATA_DIR, 'wiki-llm');
// 归档数据根目录与归档组清单文件（归档会话按组落盘，组清单持久化）
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const ARCHIVE_GROUPS_FILE = path.join(ARCHIVE_DIR, 'groups.json');
function ensureDataDirs() {
  try {
    fs.mkdirSync(WS_DATA_DIR, { recursive: true });
    fs.mkdirSync(TASK_DATA_DIR, { recursive: true });
    fs.mkdirSync(AGENTS_DATA_DIR, { recursive: true });
    fs.mkdirSync(WIKI_STORE_DIR, { recursive: true });
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  } catch (e) {
    console.error('[DSH Work Buddy] 创建数据目录失败：', e.message);
  }
}
ensureDataDirs();

// 路径归一化（比较用）：统一斜杠 + 小写盘符
function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
// 判断 dsh 工作区是否为任务专属目录（会话隔离用，不在「我的工作区」侧边栏显示）
const isTaskWorkspace = (p) => normPath(p).startsWith(normPath(TASK_DATA_DIR) + '/');

// dsh WorkspaceView → 前端工作区对象
function mapWorkspace(w) {
  return {
    id: w.workspaceId,
    name: w.title || path.basename(w.path || '') || '未命名工作区',
    path: w.path,
    sessionCount: (w.sessionIds || []).length,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt
  };
}

// ---------- 静态文件（含流式传输与 Range 支持，适配视频） ----------
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
};

function serveStatic(urlPath, res, req) {
  let p = urlPath;
  if (p === '/') p = '/index.html';
  const filePath = path.join(__dirname, p);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  serveFileFromDisk(filePath, res, req, () => { res.writeHead(404); res.end('Not found: ' + p); });
}

// 磁盘文件流式响应（含 Range 支持）：文件不存在时走 onMissing 回调
function serveFileFromDisk(filePath, res, req, onMissing) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { onMissing(); return; }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mime[ext] || 'application/octet-stream';
    const total = st.size;
    const range = req && req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      const chunkSize = end - start + 1;
      if (start >= 0 && end < total && start <= end) {
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': contentType
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': total,
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------- Wiki 文档库托管（llm-wiki VitePress 构建产物，base=/llm-wiki-plugin/） ----------
function serveWiki(urlPath, res, req) {
  if (urlPath === '/llm-wiki-plugin') {
    res.writeHead(301, { Location: WIKI_BASE });
    res.end();
    return;
  }
  const rel = urlPath.slice(WIKI_BASE.length) || 'index.html';
  const filePath = path.join(WIKI_DIST, rel);
  if (!filePath.startsWith(WIKI_DIST)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (!fs.existsSync(path.join(WIKI_DIST, 'index.html'))) {
    // 构建产物缺失：给出明确指引，而不是回落到智能体 SPA（避免误判 Wiki 已就位）
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>Wiki 未就位</title><body style="font-family:system-ui;background:#0B0E13;color:#94A3B8;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:520px"><h2 style="color:#E2E8F0">Wiki 文档库未就位</h2><p>构建产物缺失：<code>llm-wiki/project/docs/.vitepress/dist</code></p><p style="font-size:12.5px;color:#64748B">构建方法：<code>cd llm-wiki/project</code> → <code>pnpm install</code> → <code>pnpm docs:build</code>，完成后重启服务。也可用根目录 <code>start.bat</code> 一键完成。</p></div></body>');
    return;
  }
  serveFileFromDisk(filePath, res, req, () => {
    // cleanUrls=false 的产物链接均带 .html；无扩展名路径尝试补 .html 后仍失败才 404
    serveFileFromDisk(filePath + '.html', res, req, () => {
      res.writeHead(404); res.end('Not found: ' + urlPath);
    });
  });
}

// Wiki 就位检查（启动日志）：产物在则报就位 URL，缺失则给出构建指引
function ensureWiki() {
  if (fs.existsSync(path.join(WIKI_DIST, 'index.html'))) {
    const baseUrls = formatBindUrls().map((u) => u + WIKI_BASE);
    console.log(`[DSH Work Buddy] Wiki 文档库就位：${baseUrls.join('  /  ')}`);
  } else {
    console.warn(`[DSH Work Buddy] Wiki 文档库未就位（构建产物缺失）。构建方法：cd llm-wiki/project && pnpm install && pnpm docs:build，或使用根目录 start.bat 一键构建。`);
  }
}

// 技能安装（启动时）：llm-wiki 项目技能复制到 dsh 技能扫描根 .dsh/skills/（目标已有 SKILL.md 则跳过，幂等）
function ensureSkills() {
  try {
    if (fs.existsSync(path.join(SKILL_DST_DIR, 'SKILL.md'))) return;
    fs.cpSync(SKILL_SRC_DIR, SKILL_DST_DIR, { recursive: true });
    console.log('[DSH Work Buddy] 技能已安装：.dsh/skills/llm-wiki');
  } catch (e) {
    console.warn(`[DSH Work Buddy] 技能安装失败：${e.message}`);
  }
}

// ---------- 通用兼容模式 preset（Web 扩展组件，harness 用户 preset 根） ----------
// harness 支持用户自定义 preset：<dshHome>/.agent-presets/<id>/agent.cordis.yml（trust:user，agentPreset.list 可见）。
// 「通用兼容」装配：终端（POSIX 持久 bash / Windows pwsh）+ 文件编辑 + 文件搜索（fs-search）+ 网络搜索（web_search）
// + 技能目录（skill-filesystem/tool-skill）；全部使用 harness 既有工具（与 standard 同源，零新增依赖）。
// 刻意避开 subagent/workflow/goal/todo/plan/ask-user/jobs 等 DeepSeek 专用/复杂工具——
// 第三方/本地模型（非 DeepSeek 官方）在 function calling 下易因这些工具诱发失败循环（spec：thirdparty-model-preset-default）。
// 不修改 deepseek-harness 任何源码/配置；目标位于用户主目录（项目树外，符合凭证/数据安全约定），幂等安装。
const UNIVERSAL_PRESET_DIR = path.join(os.homedir(), '.dsh', '.agent-presets', 'universal');
const UNIVERSAL_PRESET_YML = `# The universal agent preset: 通用兼容模式（WorkBuddy-Web 扩展组件）。
# 工具面：终端（POSIX 持久 bash / Windows pwsh）+ 文件编辑 + 文件搜索 + 网络搜索 + 技能（skill）。
# 全部为 harness 既有基础工具（web_search 默认启用、web_fetch 关闭——web_fetch 为 SSRF 原语，见 harness Web seam 笔记）。
# 刻意避开 subagent/workflow/goal/todo/plan/ask-user/jobs 等 DeepSeek 专用/复杂工具——
# 第三方/本地模型在 function calling 下易因这些工具诱发失败循环。

- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.
      You operate in universal-compatible mode: use the terminal (bash on POSIX, PowerShell on
      Windows) for command execution, the file editor for precise file edits, file search to find
      code, web_search for current information, and the skill tool to discover and load installed
      skills (such as llm-wiki).

      Tool-calling discipline:
      * Fill in EVERY required parameter of a tool call — never omit or skip any required field.
      * The shell tools (bash/pwsh) require BOTH "command" AND "description": description is a
        short present-tense phrase for the UI, e.g. "List files in current directory".
      * If a tool call fails with an argument error (for example "missing required property"),
        read the error, fix the arguments, and retry once with the corrected call. Never give up
        on the first argument error, and never loop retrying the same broken call.

      Answer discipline:
      * Always write your final answer to the user in the visible text output. Never leave the
        answer only in your reasoning — the user cannot see reasoning as an answer.
      * Reasoning is only for your own analysis; once you have the answer, emit it as text.
      * If a task produces no answer yet, either call a tool or say so in text — do not finish
        the turn with reasoning alone.

- id: persistent-shell
  name: cordis:group
  group: true
  isolate:
    terminals: true
  config:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'
    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
      disabled: !!js process.platform === 'win32'
      config:
        timeoutMs: 300000
    - id: persistent-bash
      name: '@deepseek-ai/dsh-tool-bash-persistent'
      disabled: !!js process.platform === 'win32'
      config:
        timeoutMs: 300000
        description: |-
          Run commands in a bash shell
          * When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
          * You don't have access to the internet via this tool.
          * State is persistent across command calls and discussions with the user.
          * Please avoid commands that may produce a very large amount of output.

# Windows 上 bash 不可用：用 harness 既有 pwsh 工具补位（与 standard 的 win32 分支一致）
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'

- id: filesystem
  name: cordis:group
  group: true
  isolate:
    fs: true
  config:
    - id: fs-local
      name: '@deepseek-ai/dsh-fs-local'
      config:
        cwd: !!js process.env.DSH_CWD ?? process.cwd()
    - id: str-replace-editor
      name: '@deepseek-ai/dsh-tool-str-replace-editor'
      config:
        maxOutputChars: 16000

# 文件搜索（ripgrep，跨平台；与 standard 同源）
- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false

# 网络搜索（web_search 启用；web_fetch 关闭——SSRF 原语，保持最小面）
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: false
    searchTimeoutMs: 60000

- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
`;
const UNIVERSAL_PRESET_META = `name: 通用兼容模式
description: 终端（bash/pwsh）+ 文件编辑 + 文件搜索 + 网络搜索 + 技能目录（llm-wiki 等技能可用），面向第三方/本地模型的最小工具面。
order: 5
`;
// 幂等安装：目标目录已有 agent.cordis.yml 则跳过；写失败不阻塞启动
function ensureUniversalPreset() {
  try {
    const target = path.join(UNIVERSAL_PRESET_DIR, 'agent.cordis.yml');
    if (fs.existsSync(target)) return;
    fs.mkdirSync(UNIVERSAL_PRESET_DIR, { recursive: true });
    fs.writeFileSync(target, UNIVERSAL_PRESET_YML, 'utf8');
    fs.writeFileSync(path.join(UNIVERSAL_PRESET_DIR, 'preset.yml'), UNIVERSAL_PRESET_META, 'utf8');
    console.log(`[DSH Work Buddy] 通用兼容模式已安装：${UNIVERSAL_PRESET_DIR}（重启智能体后 agentPreset.list 可见）`);
  } catch (e) {
    console.warn(`[DSH Work Buddy] 通用兼容模式安装失败：${e.message}`);
  }
}

// ---------- 智能体服务探测与拉起 ----------
function probeHarness() {
  return new Promise((resolve) => {
    const req = http.get({
      host: HARNESS_HOST, port: HARNESS_PORT, path: '/api/host.describe', timeout: HARNESS_PROBE_TIMEOUT_MS
    }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function ensureHarness() {
  if (await probeHarness()) {
    harnessUp = true;
    if (!harnessProcess) {
      console.log(`[DSH Work Buddy] 检测到外部/遗留智能体实例（:${HARNESS_PORT}），将复用；若实例异常请先关闭 3080 端口进程再重启。`);
    } else {
      console.log(`[DSH Work Buddy] 检测到 dsh 智能体服务已在 http://${HARNESS_HOST}:${HARNESS_PORT} 运行，跳过拉起。`);
    }
    return;
  }
  await spawnHarness();
}

// 拉起智能体子进程并轮询就绪（不重复拉起：harnessBooting 期间直接返回）
async function spawnHarness() {
  if (harnessBooting) return;
  if (!fs.existsSync(HARNESS_DIR)) {
    console.error(`[DSH Work Buddy] 未找到 dsh 智能体目录：${HARNESS_DIR}，智能体服务无法自动启动。`);
    return;
  }
  harnessBooting = true;
  console.log(`[DSH Work Buddy] 启动 dsh 智能体服务（${HARNESS_DIR}）...`);
  // 端口/主机可配时显式传给 dsh（默认 3080/127.0.0.1 时不追加，保持原行为）；
  // 否则 env 覆盖的 HARNESS_PORT 与拉起进程实际监听端口不一致，探测永远失败。
  const harnessCmd = [...HARNESS_START_CMD];
  if (HARNESS_PORT !== 3080) harnessCmd.push('--port', String(HARNESS_PORT));
  if (HARNESS_HOST !== '127.0.0.1') harnessCmd.push('--host', HARNESS_HOST);
  harnessProcess = spawn('node', harnessCmd, {
    cwd: HARNESS_DIR,
    stdio: 'inherit',
    env: { ...process.env }
  });
  harnessProcess.on('exit', (code) => {
    harnessUp = false;
    console.log(`[DSH Work Buddy] dsh 智能体服务已退出（code=${code}）。`);
  });
  harnessProcess.on('error', (err) => {
    harnessUp = false;
    console.error(`[DSH Work Buddy] 启动 dsh 智能体服务失败：${err.message}`);
  });

  const deadline = Date.now() + HARNESS_READY_TIMEOUT_MS;
  const poll = async () => {
    if (await probeHarness()) {
      harnessUp = true;
      harnessBooting = false;
      console.log(`[DSH Work Buddy] dsh 智能体服务就绪：http://${HARNESS_HOST}:${HARNESS_PORT}`);
      return;
    }
    if (Date.now() > deadline) {
      harnessBooting = false;
      console.warn(`[DSH Work Buddy] 等待 dsh 智能体服务超时（${HARNESS_READY_TIMEOUT_MS / 1000}s），请检查其日志。`);
      return;
    }
    setTimeout(poll, HARNESS_PROBE_INTERVAL_MS);
  };
  poll();
}

// ---------- 智能体自愈：RPC 转发失败（连接不上 3080）时按需复活 ----------
// 前端 waitHarnessReady 的 host.describe 轮询会持续打到网关 → 网关在转发失败时顺手拉起智能体，
// 形成「智能体崩溃 → 下一次 RPC 自动复活」的闭环（冷却 10s 防拉起风暴）。
const HARNESS_REVIVE_COOLDOWN_MS = 10000;
let harnessLastReviveAt = 0;
let harnessReviving = false;
function reviveHarness() {
  if (harnessReviving || harnessBooting) return;
  if (Date.now() - harnessLastReviveAt < HARNESS_REVIVE_COOLDOWN_MS) return;
  harnessReviving = true;
  harnessLastReviveAt = Date.now();
  probeHarness().then(async (up) => {
    if (up) {
      harnessUp = true;
      harnessReviving = false;
      return;
    }
    console.warn('[DSH Work Buddy] 检测到智能体服务不可达，自动拉起…');
    await spawnHarness();
    harnessReviving = false;
  });
}

// ---------- 优雅关闭：退出信号 → 关网关 + 关 WS 连接 + 关智能体子进程（组件同关，不留孤儿） ----------
const upgradeSockets = new Set(); // WS 升级 socket 跟踪（优雅关闭时需主动销毁，否则 server.close() 被长连接卡住）
let shuttingDown = false;

// 关闭智能体子进程：先 SIGTERM，1.5s 未退则强制杀进程树。
// Windows 用 taskkill /T /F（含 tsx 派生的孙进程）；macOS/Linux 用 SIGKILL（POSIX 兜底）。
function shutdownHarness() {
  const p = harnessProcess;
  if (!p || p.exitCode !== null || p.killed) return;
  const pid = p.pid;
  try { p.kill('SIGTERM'); } catch (e) { /* 已退出则忽略 */ }
  setTimeout(() => {
    if (harnessProcess && harnessProcess.exitCode === null && pid) {
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* 忽略 */ }
      } else {
        try { process.kill(pid, 'SIGKILL'); } catch (e) { /* 已退出则忽略 */ }
      }
    }
  }, 1500).unref();
}

function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[DSH Work Buddy] 正在关闭：${reason}`);
  // 0) 运行期协议兜底：恢复临时降级的协议（不持久化降级结果；1.5s 内尽力完成，失败不阻塞退出）
  Promise.race([restoreProtoOverrides(), new Promise((r) => setTimeout(r, 1500))])
    .catch(() => {})
    .then(() => {
      // 1) 主动销毁所有 WS 升级连接，避免 server.close() 等长连接卡住
      for (const s of upgradeSockets) { try { s.destroy(); } catch (e) { /* 忽略 */ } }
      upgradeSockets.clear();
      // 2) 停止接受新连接（http server 关）→ 现有连接自然结束后立即退出；未 listen 场景由 3s 兜底兜住
      try { server.close(() => process.exit(code)); } catch (e) { /* 忽略 */ }
      // 3) 关闭智能体子进程（组件同关）
      shutdownHarness();
      // 4) 兜底强制退出：3s 后无论 close 回调是否触发都退出
      setTimeout(() => process.exit(code), 3000).unref();
    });
}

// ---------- 代理转发（HTTP + WebSocket） ----------
// 本地业务 mock 前缀（不转发）
const LOCAL_API_PREFIXES = [
  '/api/workspaces', '/api/tasks', '/api/archive', '/api/wiki',
  '/api/resources', '/api/schedule', '/api/search', '/api/plugin-community',
  '/api/model-modality', '/api/probe-responses'
];
const isLocalApi = (p) => p === '/api/workspaces/sync-harness' || LOCAL_API_PREFIXES.some((pre) => p === pre || p.startsWith(pre + '/'));

// WorkBuddy 自身的静态资源（不转发）
const WORKBUDDY_STATIC = (p) =>
  p === '/' || p === '/index.html' ||
  p === '/logo.jpg' || p === '/favicon.ico' || p === '/favicon.png' ||
  p.startsWith('/card-bg/') ||
  p.startsWith('/modules/');

// 解析转发目标路径：/harness/ 前缀去掉
function resolveProxyPath(url) {
  const pathname = url.split('?')[0];
  if (pathname === '/harness' || pathname.startsWith('/harness/')) {
    return url.replace(/^\/harness/, '') || '/';
  }
  return url;
}

function shouldProxy(url) {
  const pathname = url.split('?')[0];
  if (pathname === '/harness' || pathname.startsWith('/harness/')) return true;
  if (pathname.startsWith('/api/')) {
    // RPC 方法、respond、事件流、会话导出一律转发；本地业务 mock 不转发
    if (pathname.startsWith('/api/respond')) return true;
    if (pathname.startsWith('/api/events.mux') || pathname.startsWith('/api/events.host')) return true;
    if (pathname.startsWith('/api/session.export')) return true;
    return !isLocalApi(pathname);
  }
  if (WORKBUDDY_STATIC(pathname)) return false;
  // 其余路径（/assets/、/plugins/、SPA 内部路由、favicon 等）转发到 dsh 智能体
  return true;
}

function proxyHttp(req, res, targetPath) {
  const headers = { ...req.headers, host: `${HARNESS_HOST}:${HARNESS_PORT}` };
  delete headers.connection;
  // dsh 连接围栏：浏览器请求携带 Origin（=8765）时与转发后的 Host（=3080）不匹配会被 403 forbidden。
  // 网关是同源可信前端，统一改写 Origin 为智能体自身地址（与 proxyUpgrade 的 WS 升级处理一致）。
  headers.origin = `http://${HARNESS_HOST}:${HARNESS_PORT}`;
  const proxyReq = http.request({
    host: HARNESS_HOST, port: HARNESS_PORT, path: targetPath, method: req.method, headers
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => {
    // 智能体不可达：顺手触发自愈拉起（冷却防风暴），前端轮询期间即可恢复
    reviveHarness();
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ ok: false, error: { code: 'harness-offline', message: 'dsh 智能体服务未就绪' } }));
  });
  req.pipe(proxyReq);
}

function proxyUpgrade(req, socket, head) {
  // 跟踪 WS 升级连接：优雅关闭时统一销毁，避免 server.close() 被长连接卡住
  upgradeSockets.add(socket);
  socket.on('close', () => upgradeSockets.delete(socket));
  const headers = { ...req.headers };
  delete headers.connection;
  headers.host = `${HARNESS_HOST}:${HARNESS_PORT}`;
  headers.connection = 'Upgrade';
  headers.upgrade = 'websocket';
  headers.origin = `http://${HARNESS_HOST}:${HARNESS_PORT}`;
  const proxyReq = http.request({
    host: HARNESS_HOST, port: HARNESS_PORT, path: req.url, method: 'GET', headers
  });
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    // 转发 101 状态行与响应头（含 Sec-WebSocket-Accept）给客户端
    const statusLine = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
    let headerBlock = '';
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      headerBlock += `${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`;
    }
    socket.write(statusLine + headerBlock + '\r\n');
    if (proxyHead && proxyHead.length) socket.write(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
  });
  proxyReq.on('error', () => socket.destroy());
  proxyReq.end(head || undefined);
}

// ---------- 本地业务 mock 数据（工作区/插件/技能已直连 dsh RPC，此处仅本地数据） ----------
const db = {
  tasks: [],
  archiveGroups: [],
  agentTemplates: [],
  pluginCommunity: [] // 用户自建收藏（内存；预置精选见 PLUGIN_COMMUNITY_SEED）
};

// ---------- 智能体模板持久化（data/agents/templates.json） ----------
// 模板定义（id/name/description/preset/prompt）此前仅存内存 db，网关重启即全部丢失；
// 现落盘 + 启动恢复；记忆文件（data/agents/<id>/MEMORY.md）本就落盘，一并支持孤儿恢复。
// 另含代码级预置（AGENT_TEMPLATES_SEED）：templates.json 尚未生成（全新安装/发布包首次启动）时注入，
// 用户删除/编辑后落盘即固化，重启不重复注入；记忆文件按模板 id 懒建。
const AGENT_TEMPLATES_SEED = [
  {
    id: 'tpl-preset-doc-writer',
    name: '技术文档工程师',
    description: '编写与整理 README、接口文档、架构说明等规范化技术文档，输出结构化 Markdown。',
    preset: 'code',
    prompt: '你是技术文档工程师。职责：编写与维护高质量技术文档（README、API 接口文档、架构设计说明、部署手册、变更日志）。要求：1) 输出规范 Markdown，层级清晰（标题/列表/表格/代码块）；2) 接口文档含请求参数、返回结构、错误码与示例；3) 面向读者写作，先结论后细节，避免口语化；4) 引用文件路径与命令须准确可复制；5) 涉及不确定的实现细节，先向用户确认再落笔。',
    createdAt: null,
    presetSeed: true
  },
  {
    id: 'tpl-preset-data-analyst',
    name: '数据分析助手',
    description: '数据清洗、统计汇总与报表解读：从原始数据提炼指标、对比与结论建议。',
    preset: 'standard',
    prompt: '你是数据分析助手。职责：数据整理、统计汇总、指标计算与报表解读。要求：1) 先明确分析目标与口径（时间范围/维度/去重规则），不清晰时先提问；2) 展示关键步骤与中间结果，数字保留两位小数并标注单位；3) 结论分层：事实（数据说什么）→ 判断（意味着什么）→ 建议（下一步做什么）；4) 对可疑数据（缺失/异常值/口径不一致）显式标注而非静默处理；5) 输出建议用表格呈现明细。',
    createdAt: null,
    presetSeed: true
  },
  {
    id: 'tpl-preset-translator',
    name: '翻译润色助手',
    description: '中英互译与文本润色：忠实原意、语句自然，技术术语保留英文并附注释。',
    preset: 'minimal',
    prompt: '你是翻译与润色助手。职责：中英互译、文本润色、术语统一。要求：1) 忠实原文语义与语气，不增删信息；2) 译文符合目标语言习惯，避免翻译腔；3) 技术术语（如 API、token、pipeline）首次出现保留英文并括注中文；4) 润色时保持原文结构，仅优化表达；5) 长文分段处理，每段给出译文；6) 发现原文歧义或疑似笔误，在译文后以「注：」标出。',
    createdAt: null,
    presetSeed: true
  },
  {
    id: 'tpl-preset-copywriter',
    name: '创意文案策划',
    description: '营销文案、社交媒体内容与活动策划：多风格产出，附传播要点与适用场景。',
    preset: 'cordis',
    prompt: '你是创意文案策划。职责：营销文案、社交媒体内容、活动策划与品牌命名。要求：1) 先确认目标受众、投放渠道与调性（专业/活泼/高级感）；2) 每次提供 3 个不同方向的方案，各附一句创意逻辑说明；3) 文案符合渠道特点（标题字数、话题标签、行动号召）；4) 避免夸大与违规用词（绝对化用语、虚假承诺）；5) 活动策划含目标、主题、流程、传播路径与效果衡量指标。',
    createdAt: null,
    presetSeed: true
  }
];
const AGENT_TEMPLATES_FILE = path.join(AGENTS_DATA_DIR, 'templates.json');
// 智能体模板清单落盘：版本化信封 + 原子写入（.bak 备份），网关重启不丢失
function saveAgentTemplates() {
  try {
    openJsonStore(AGENT_TEMPLATES_FILE, { initial: [] }).replace(db.agentTemplates);
  } catch (e) { /* 写盘失败不阻塞模板操作 */ }
}
// 加载模板清单：文件缺失（全新安装）→ 注入代码级预置（不落盘）；文件存在 → 读取（旧裸数组自动迁移为版本信封）
function loadAgentTemplates() {
  try {
    const store = openJsonStore(AGENT_TEMPLATES_FILE, { initial: [], allowCreate: false });
    if (store.exists) {
      // 文件存在：即使为空也以文件为准（用户显式清空的清单保持为空）
      db.agentTemplates = Array.isArray(store.data) ? store.data.filter((t) => t && t.id) : [];
      return;
    }
  } catch (e) { /* 文件损坏 → 走 seed 兜底 */ }
  // 全新安装（发布包首次启动，无 templates.json）：注入代码级预置智能体（不落盘，
  // 保持 data/ 为空以满足打包脱敏；用户首次增删改时固化到盘）
  db.agentTemplates = AGENT_TEMPLATES_SEED.map((t) => ({ ...t }));
}
// 孤儿记忆恢复：data/agents 下存在 MEMORY.md 但模板清单中已无定义的 tpl_* 目录（此前重启丢失的模板），
// 以占位模板找回（可重命名/编辑），避免用户创建的智能体「凭空消失」。
function recoverOrphanAgentTemplates() {
  const existing = new Set(db.agentTemplates.map((t) => t.id));
  const recovered = [];
  let list = [];
  try { list = fs.readdirSync(AGENTS_DATA_DIR, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of list) {
    // tpl-preset-* 为代码级预置模板（seed）记忆目录：seed 仅在 templates.json 未生成时注入内存，
    // 固化后不属于持久化清单；其记忆属预置模板生命周期，不应经「孤儿找回」重新出现在资源仓库。
    if (!ent.isDirectory() || !/^tpl_/.test(ent.name) || ent.name.startsWith('tpl-preset-') || existing.has(ent.name)) continue;
    const mem = path.join(AGENTS_DATA_DIR, ent.name, 'MEMORY.md');
    if (!fs.existsSync(mem)) continue;
    let createdAt = null;
    try { createdAt = fs.statSync(path.join(AGENTS_DATA_DIR, ent.name)).mtime.toISOString(); } catch (e) { /* 取时间失败置空 */ }
    recovered.push({
      id: ent.name,
      name: ent.name,
      description: '（原模板定义已随网关重启丢失，已从记忆文件恢复；可在此重命名与编辑）',
      preset: 'standard',
      prompt: '',
      createdAt,
      recoveredFromMemory: true
    });
  }
  if (recovered.length) {
    db.agentTemplates.push(...recovered);
    saveAgentTemplates();
    console.log(`[DSH Work Buddy] 已从记忆文件恢复 ${recovered.length} 个智能体模板（定义丢失，占位恢复）`);
  }
}
loadAgentTemplates();
recoverOrphanAgentTemplates();

// 插件社区：预置精选站点（活跃、评价高，前端不可删除）+ 用户自建收藏
const PLUGIN_COMMUNITY_SEED = [
  { id: 'pc-topic-dsh-plugin', name: 'GitHub · dsh-plugin 专题', url: 'https://github.com/topics/dsh-plugin', tag: '社区', scale: '官方专题', color: '#4A90D9', desc: 'dsh 智能体插件官方聚合专题：插件、技能与扩展持续收录。' },
  { id: 'pc-deepseek', name: 'DeepSeek · GitHub', url: 'https://github.com/deepseek-ai', tag: '官方', scale: '官方组织', color: '#4D6BFE', desc: 'DeepSeek 官方开源组织：模型、推理、Agent 相关仓库。' },
  { id: 'pc-hf', name: 'Hugging Face', url: 'https://huggingface.co', tag: '模型', scale: '全球最大 AI 社区', color: '#FFD21E', desc: '模型、数据集、Agents、Skills 与 Spaces 一站式社区，智能体技能生态丰富。' },
  { id: 'pc-claude-skills', name: 'Anthropic · Claude Skills', url: 'https://github.com/anthropics/skills', tag: '技能', scale: '官方 Skills 仓库', color: '#D97757', desc: 'Claude 官方技能仓库：Agent 技能定义、目录约定与最佳实践。' },
  { id: 'pc-openai-agents', name: 'OpenAI Agents SDK', url: 'https://github.com/openai/openai-agents-python', tag: '智能体', scale: '50k+ Stars', color: '#10A37F', desc: 'OpenAI 官方智能体框架：多智能体、工具调用与可观测追踪。' },
  { id: 'pc-dify', name: 'Dify', url: 'https://github.com/langgenius/dify', tag: '智能体', scale: '100k+ Stars', color: '#3B82F6', desc: 'LLM 应用开发平台：Agent 编排、工作流与插件市场生态。' },
  { id: 'pc-smolagents', name: 'Hugging Face · smolagents', url: 'https://github.com/huggingface/smolagents', tag: '智能体', scale: '25k+ Stars', color: '#FF9D00', desc: '极简智能体框架：Code Agent 与工具调用，社区活跃度高。' },
  { id: 'pc-ollama', name: 'Ollama', url: 'https://github.com/ollama/ollama', tag: '模型', scale: '100k+ Stars', color: '#7C3AED', desc: '本地大模型运行社区：一行命令拉起模型，插件与工具生态完善。' },
  { id: 'pc-modelscope', name: '魔搭 ModelScope', url: 'https://modelscope.cn', tag: '社区', scale: '中文社区', color: '#FF5A00', desc: '阿里达摩院 AI 开源社区：模型、数据集与 Agent 应用，中文活跃度高。' }
];
// 用户自建收藏持久化（data/plugin-community.json，重启恢复；预置 9 项为代码级恒在）
const PLUGIN_COMMUNITY_FILE = path.join(DATA_DIR, 'plugin-community.json');
function loadPluginCommunity() {
  try {
    // 旧裸数组自动迁移为版本信封；文件缺失不建空文件（首次收藏时才落盘）
    const store = openJsonStore(PLUGIN_COMMUNITY_FILE, { initial: [], allowCreate: false });
    db.pluginCommunity = Array.isArray(store.data) ? store.data.filter((p) => p && p.id) : [];
  } catch (e) { db.pluginCommunity = []; }
}
function savePluginCommunity() {
  try {
    openJsonStore(PLUGIN_COMMUNITY_FILE, { initial: [] }).replace(db.pluginCommunity);
  } catch (e) { /* 写盘失败不阻塞收藏操作 */ }
}
loadPluginCommunity();

function nextId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function seedData() {
  // 演示任务（工作区改为按需绑定；真实工作区列表由 dsh workspace.list 提供）
  const now = new Date().toISOString();
  db.tasks = [
    { id: nextId('t'), title: '完成项目总览设计', status: 'in_progress', workspaceId: null, dir: null, deadline: null, createdAt: now, completedAt: null },
    { id: nextId('t'), title: '整理 Wiki 文档', status: 'today', workspaceId: null, dir: null, deadline: now, createdAt: now, completedAt: null },
    { id: nextId('t'), title: '集成智能体组件', status: 'completed', workspaceId: null, dir: null, deadline: null, createdAt: now, completedAt: null },
    { id: nextId('t'), title: '修复逾期任务提醒', status: 'overdue', workspaceId: null, dir: null, deadline: '2024-01-01T00:00:00Z', createdAt: now, completedAt: null }
  ];
  // 演示任务目录兜底：创建时即分配专属目录（演示任务无工作区归属，落 data/tasks/<id>；失败不阻塞演示数据）
  db.tasks.forEach((t) => { ensureTaskDir(t); });
}

// ---------- 任务持久化（任务目录内 task.json：重启恢复任务及其会话关联） ----------
// 任务元数据文件名（存于任务专属目录内，随任务全字段序列化）
const TASK_FILE = 'task.json';

// 写任务元数据：dir 有效且存在才落盘；失败静默 warn（不阻塞业务）
function saveTaskFile(task) {
  if (!task || !task.dir || !fs.existsSync(task.dir)) return;
  try {
    fs.writeFileSync(path.join(task.dir, TASK_FILE), JSON.stringify(task, null, 2), 'utf8');
  } catch (e) {
    console.warn('[DSH Work Buddy] 写入 task.json 失败：', e.message);
  }
}

// 从磁盘恢复任务：收集 data/tasks/<任务>/task.json 与 data/workspaces/<工作区>/<任务>/task.json
// （一级目录里出现 task.json 即视为任务目录）；无 task.json 的目录静默跳过（旧任务/空目录），
// 存在但解析失败才 warn；按 createdAt 升序返回
function loadTasksFromDisk() {
  const tasks = [];
  const visit = (dir) => {
    const file = path.join(dir, TASK_FILE);
    if (!fs.existsSync(file)) return; // 旧任务目录/空目录：无档案文件，静默跳过
    try {
      const task = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (task && task.id) tasks.push(task);
      else console.warn('[DSH Work Buddy] 跳过无效 task.json：', file);
    } catch (e) {
      console.warn('[DSH Work Buddy] 跳过损坏的 task.json：', file, e.message);
    }
  };
  // 兜底任务目录：data/tasks/<id>/
  try {
    for (const ent of fs.readdirSync(TASK_DATA_DIR, { withFileTypes: true })) {
      if (ent.isDirectory()) visit(path.join(TASK_DATA_DIR, ent.name));
    }
  } catch (e) { /* 目录缺失时跳过 */ }
  // 工作区下任务目录：data/workspaces/<工作区>/<taskId>/
  try {
    for (const wsEnt of fs.readdirSync(WS_DATA_DIR, { withFileTypes: true })) {
      if (!wsEnt.isDirectory()) continue;
      const wsDir = path.join(WS_DATA_DIR, wsEnt.name);
      for (const ent of fs.readdirSync(wsDir, { withFileTypes: true })) {
        if (ent.isDirectory()) visit(path.join(wsDir, ent.name));
      }
    }
  } catch (e) { /* 目录缺失时跳过 */ }
  tasks.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return tasks;
}

// ---------- 归档组持久化（data/archive/groups.json：组清单，含手动新建的空组） ----------
// 启动加载组清单：文件不存在/损坏/为空 → 给默认组并落盘（保证组 id 跨重启稳定）；旧裸数组自动迁移为版本信封
function loadArchiveGroups() {
  let groups = [];
  try {
    const arr = openJsonStore(ARCHIVE_GROUPS_FILE, { initial: [] }).data;
    if (Array.isArray(arr)) groups = arr.filter((g) => g && g.id && g.name);
  } catch (e) { /* 文件缺失/损坏 → 默认组 */ }
  if (groups.length) {
    db.archiveGroups = groups;
    return;
  }
  db.archiveGroups = [{ id: nextId('ag'), name: '默认组' }];
  saveArchiveGroups();
}

// 归档组清单落盘（新建组后调用）：版本化信封 + 原子写入
function saveArchiveGroups() {
  try {
    openJsonStore(ARCHIVE_GROUPS_FILE, { initial: [] }).replace(db.archiveGroups);
  } catch (e) {
    console.warn('[DSH Work Buddy] 写入归档组清单失败：', e.message);
  }
}

// 目录名安全化（归档目录用）：去 Windows 非法字符与空白控制符，截断 60 字符，空值兜底
function safeName(name, fallback) {
  const s = String(name || '').replace(/[\\/:*?"<>|\r\n\t]/g, '').trim().slice(0, 60);
  return s || fallback || '未命名';
}

// ---------- 启动初始化：任务磁盘恢复（核心：重启不丢对话记录与会话关联） ----------
loadArchiveGroups(); // 归档组清单（groups.json）
(async () => {
  const restored = loadTasksFromDisk();
  if (restored.length) {
    // 磁盘有任务 → 直接恢复，跳过 seedData（不再注入演示任务，幂等）
    db.tasks = restored;
    console.log(`[DSH Work Buddy] 已从磁盘恢复 ${restored.length} 个任务（跳过演示数据注入）。`);
  } else {
    seedData();
    // seed 任务逐个落盘：ensureTaskDir 为 async（dir 赋值在微任务后），等目录解析完成再写 task.json
    await Promise.all(db.tasks.map((t) => ensureTaskDir(t)));
    db.tasks.forEach((t) => saveTaskFile(t));
  }
})();

// 工作区路径缓存（workspaceId → path）：GET /api/workspaces 时填充；任务目录解析未命中时查 workspace.list 补齐
const workspaceCache = new Map();

// 递归扫描工作区文件（最深 4 层，跳过隐藏文件与 node_modules），返回相对路径清单
function workspaceFiles(root) {
  const files = [];
  const visit = (dir, relative, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const full = path.join(dir, ent.name);
      const rel = relative ? `${relative}/${ent.name}` : ent.name;
      if (ent.isDirectory()) visit(full, rel, depth + 1);
      else if (ent.isFile()) {
        try { const st = fs.statSync(full); files.push({ name: rel, size: st.size, modifiedAt: st.mtime.toISOString() }); } catch (_) { /* 文件消失 */ }
      }
    }
  };
  visit(root, '', 0);
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

// 解析任务专属目录：workspaceId 有效时优先建在工作区目录下（<工作区path>/<taskId>），否则兜底 data/tasks/<taskId>
async function taskDirFor(taskId, workspaceId) {
  if (workspaceId) {
    if (!workspaceCache.has(workspaceId)) {
      try {
        const v = await harnessRpc('workspace.list', {});
        (v.items || []).forEach((w) => { if (w.workspaceId) workspaceCache.set(w.workspaceId, w.path); });
      } catch (e) {
        console.warn('[DSH Work Buddy] 查询工作区失败，任务目录兜底 data/tasks：', e.message);
      }
    }
    const wsPath = workspaceCache.get(workspaceId);
    if (wsPath) return path.join(wsPath, taskId);
  }
  return path.join(TASK_DATA_DIR, taskId);
}

// 任务目录兜底（async）：dir 已存在且目录在 → 不动；dir 在但目录丢失 → 按原路径重建；无 dir → taskDirFor 解析（优先工作区下）并写回
// （会话隔离与智能体档案落盘的物理边界）
async function ensureTaskDir(task) {
  if (!task) return;
  if (task.dir) {
    if (!fs.existsSync(task.dir)) {
      try { fs.mkdirSync(task.dir, { recursive: true }); } catch (e) { /* 目录创建失败时任务仍可用 */ }
    }
    return;
  }
  task.dir = await taskDirFor(task.id, task.workspaceId);
  try { fs.mkdirSync(task.dir, { recursive: true }); } catch (e) { /* 目录创建失败时任务仍可创建 */ }
}

// ---------- 智能体内置记忆（长期画像，按模板 id 存放于 data/agents/<tplId>/MEMORY.md） ----------
// 初始记忆模板：分节结构固定，智能体按节维护；now 为初次对话时间
function memoryTemplate(now) {
  return `# 智能体长期记忆

> 维护规则：本文件只记录用户的特点与偏好类信息，不记录具体做过哪些任务及其详细内容。

## 用户画像（说话方式 / 喜好 / 忌讳 / 沟通方式）
（待补充）

## 用户格外强调过的事
（待补充）

## 因用户特点需额外考虑
（待补充）

## 关键日期
- 初次对话时间：${now}
（其余待补充）

## 事项概览（大致完成数量 / 周期性事项）
（待补充）
`;
}

// 智能体记忆文件路径：data/agents/<tplId>/MEMORY.md（tplId 清洗防路径穿越，空值归 '_default'）
function agentMemoryFile(tplId) {
  const safe = String(tplId || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '_default';
  return path.join(AGENTS_DATA_DIR, safe, 'MEMORY.md');
}

// 读取智能体内置记忆：不存在则用模板初始化（懒建）并返回内容；tplId 为空时归 '_default'
function getAgentMemory(tplId) {
  const file = agentMemoryFile(tplId);
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    const content = memoryTemplate(new Date().toISOString());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return content;
  } catch (e) {
    return memoryTemplate(new Date().toISOString()); // 落盘失败时退回模板内容，会话仍可进行
  }
}

// ---------- 项目工作指南（注入 AGENTS.md，动态注入资源仓库与任务目录绝对路径） ----------
function PROJECT_GUIDE_MD(wikiDir, taskDir) {
  return `## 项目工作指南

### 资源仓库
- 资源仓库 = 本项目的 Wiki 文档库（是文档集合概念，不是本地文件夹！）。
- 用户说「保存到资源仓库」= 创建一份带元数据的 markdown 文档写入 ${wikiDir}（绝对路径）。
- 文档规范：frontmatter 三要素 title（名称）/ description（简介）/ tags（数组，至少 3 个标签），frontmatter 之后是正文。
- 禁止把「资源仓库」理解为在磁盘新建目录。

### 检索约定
- 本地 wiki 检索一律使用 wiki_search.py --no-embed（纯词法 BM25，零依赖零模型）。
- 未经用户明确要求：禁止运行 init_wiki.py / setup_wiki.py、禁止 pip/uv/npm 安装任何依赖、禁止下载嵌入模型（本地未配置 FastEmbed 模型，混合检索不可用）。

### 任务文件夹
- ${taskDir}（绝对路径）是当前任务专属文件夹。
- 会话产生的文件、上传的文件、生成的文件一律保存在此目录。
- 任务结束归档时以此目录为数据源。

### 会话书架
- 用户挂载的参考文档会列在下方「会话书架」一节（文件名/所属分类/所属库名/文件路径）。
- 需要文档内容时按文件路径读取全文。
`;
}

// 分类中文名（AGENTS.md 书架表展示用）：note → 个人笔记，其它原样
function categoryLabel(c) {
  return c === 'note' ? '个人笔记' : (c || '');
}

// 组装任务目录 AGENTS.md 全文：身份 + 项目工作指南 + 长期记忆 +（书架非空时）会话书架 + 记忆维护说明
// （dsh 会话以任务目录为 cwd 读取该文件；shelfDocs 为 [{name,category,library,path}]，可空/缺省兼容旧调用）
function composeAgentsMd(task, memoryContent, shelfDocs) {
  const tpl = task && task.agentTemplate;
  const identity = tpl
    ? `# 智能体身份\n\n你是「${tpl.name || '未命名智能体'}」。\n- 运行预设：${tpl.preset || 'standard'}\n- 角色设定：${tpl.prompt || '（无）'}`
    : '# 智能体身份\n\n你是 DSH Work Buddy 智能体助手。';
  let md = `${identity}

${PROJECT_GUIDE_MD(wikiGuideDir(), (task && task.dir) || TASK_DATA_DIR)}

## 长期记忆

${memoryContent}
`;
  if (shelfDocs && shelfDocs.length) {
    md += `
## 会话书架（用户挂载的参考资料）
| 文件名 | 所属分类 | 所属库名 | 文件路径 |
| --- | --- | --- | --- |
`;
    for (const d of shelfDocs) {
      md += `| ${d.name || ''} | ${categoryLabel(d.category)} | ${d.library || ''} | ${d.path || ''} |\n`;
    }
    md += `（以上为文档清单；需要文档具体内容时，按"文件路径"读取该文件。）\n`;
  }
  md += `
## 记忆维护说明
对话过程中若了解到用户的新特点（说话方式、喜好、忌讳、沟通方式、格外强调的事、需额外考虑的事、关键日期、大致事项数量与周期性事项），请即时更新本目录下的 MEMORY.md 文件（保持上述分节结构）。只记用户特点，不记录具体任务内容。
`;
  return md;
}

// ---------- 会话书架（任务挂载的 wiki 参考文档：task.dir/.workbuddy/shelf.json） ----------
// 读取书架：task 无 dir → null（调用方兜底 []）；shelf.json 不存在/损坏 → []
function readShelf(task) {
  if (!task || !task.dir) return null;
  try {
    const file = path.join(task.dir, '.workbuddy', 'shelf.json');
    if (!fs.existsSync(file)) return [];
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

// 书架条目 → AGENTS.md 会话书架节行数据（只保留 文件名/所属分类/所属库名 + 文档库内绝对路径）
function shelfDocsForAgents(task) {
  return (readShelf(task) || []).map((d) => ({
    name: d.title || '',
    category: d.category || 'note',
    library: d.library || '本地文档库',
    path: path.join(WIKI_STORE_DIR, d.relPath || '')
  }));
}

// 写书架并重组任务目录智能体档案：shelf.json 落盘 + AGENTS.md 全量重写（MEMORY.md 存在则不动，种子逻辑沿用）
function writeShelfAndAgents(task, shelf) {
  if (!task || !task.dir) return;
  try {
    fs.mkdirSync(path.join(task.dir, '.workbuddy'), { recursive: true });
    fs.writeFileSync(path.join(task.dir, '.workbuddy', 'shelf.json'), JSON.stringify(shelf || [], null, 2), 'utf8');
    writeTaskAgentFiles(task);
  } catch (e) {
    console.warn('[DSH Work Buddy] 写入会话书架失败：', e.message);
  }
}

// 任务目录智能体档案落盘：AGENTS.md（身份+指南+记忆+书架+维护说明）；MEMORY.md 仅在缺失时写入记忆种子
function writeTaskAgentFiles(task) {
  if (!task.dir || !fs.existsSync(task.dir)) return;
  try {
    const memory = getAgentMemory(task.agentTemplate && task.agentTemplate.id);
    fs.writeFileSync(path.join(task.dir, 'AGENTS.md'), composeAgentsMd(task, memory, shelfDocsForAgents(task)), 'utf8');
    const memFile = path.join(task.dir, 'MEMORY.md');
    if (!fs.existsSync(memFile)) fs.writeFileSync(memFile, memory, 'utf8');
  } catch (e) {
    console.warn('[DSH Work Buddy] 写入任务智能体档案失败：', e.message);
  }
}

// ---------- Wiki 轻量文档库（lite：data/wiki 下 markdown + frontmatter；mode 可切 llm-wiki） ----------
// 模式标记文件：lite（默认，轻量本地库）/ llm-wiki（写入 data/wiki-llm 数据源目录）
const WIKI_MODE_FILE = path.join(WIKI_STORE_DIR, '.mode');

// llm-wiki 模式骨架文档（首次写入文档时创建，存在则不覆盖）
const LLM_WIKI_SCHEMA_MD = `# llm-wiki 数据结构说明

- \`sources/\`：知识源文档（markdown，frontmatter 三要素 title / description / tags）
- 知识源由网关在 llm-wiki 模式下自动写入本目录
`;
const LLM_WIKI_INDEX_MD = `# llm-wiki 文档库

知识源位于 \`sources/\` 目录。
`;

// 注入到各任务目录的 llm-wiki 知识库调用说明（.workbuddy/llm-wiki-guide.md，幂等写入）
// 目的：技能清单为空/未安装时，会话内智能体仍可凭此说明通过 curl 调用网关 Wiki API 读写知识库。
// 注意：与任务目录 AGENTS.md 中动态注入的「项目工作指南」不同，本文件为静态说明，不随 wiki 模式/路径变化。
function LLM_WIKI_GUIDE_MD() {
  return `# llm-wiki 知识库调用说明

本任务的工作区数据（会话/文件）以任务目录为边界；项目知识库（Wiki 文档库）由网关 8765 统一托管，
智能体可通过 HTTP 调用以下接口读写知识库文档（本地地址 http://127.0.0.1:8765）。

## 常用接口

- 文档清单：\`GET /api/wiki/docs\` → \`{docs: [{relPath, title, description, tags, category, repoSlug}]}\`
- 仓库清单：\`GET /api/wiki/repos\` → \`{repos: [{category, slug, name}]}\`
- 读取全文：\`GET /api/wiki/doc?path=<relPath>\` → \`{content}\`
- 检索文档：\`GET /api/wiki/search?q=<关键词>\` → \`{results: [{relPath, title, description, tags}]}\`
- 新建/上传文档：\`POST /api/wiki/write\`，JSON body 形如：
  \`\`\`json
  { "title": "文档标题", "description": "一句话简介", "tags": ["标签1", "标签2", "标签3"],
    "category": "note", "repo": "default", "content": "正文 markdown" }
  \`\`\`
  （title/description 必填，tags 至少 3 个，category 限定 material/note/agent-doc/experience/archive，repo 为仓库 slug）
- 编辑文档（可改标题/正文/移动仓库）：\`PUT /api/wiki/doc\`，body 含 \`path\`（原 relPath）+ 上述字段
- 删除文档：\`DELETE /api/wiki/doc?path=<relPath>\`

## 调用示例

\`\`\`bash
# 列文档
curl -s "http://127.0.0.1:8765/api/wiki/docs"
# 读全文
curl -s "http://127.0.0.1:8765/api/wiki/doc?path=note/示例.md"
# 检索
curl -s "http://127.0.0.1:8765/api/wiki/search?q=DeepSeek"
# 新建文档（归入 note/default 仓库）
curl -s -X POST "http://127.0.0.1:8765/api/wiki/write" -H "Content-Type: application/json" -d '{
  "title": "示例文档", "description": "示例", "tags": ["示例", "wiki", "说明"],
  "category": "note", "repo": "default", "content": "# 正文"
}'
\`\`\`

## 约定

- 用户说「保存到资源仓库」= 通过 \`POST /api/wiki/write\` 创建带元数据的 markdown 文档（不要新建本地目录）。
- 检索优先用 \`wiki_search.py --no-embed\`（若可用）；HTTP 检索接口 \`/api/wiki/search\` 作为通用备选。
`;
}

// 读取 wiki 模式（默认 lite；文件损坏/缺失均回退 lite）
function getWikiMode() {
  try {
    return fs.readFileSync(WIKI_MODE_FILE, 'utf8').trim() === 'llm-wiki' ? 'llm-wiki' : 'lite';
  } catch (e) {
    return 'lite';
  }
}

// 写入 wiki 模式标记
function setWikiMode(mode) {
  fs.mkdirSync(WIKI_STORE_DIR, { recursive: true });
  fs.writeFileSync(WIKI_MODE_FILE, mode, 'utf8');
}

// 指南中的资源仓库写入目录：lite = WIKI_STORE_DIR；llm-wiki = WIKI_LLM_DIR/sources（与 POST /api/wiki/doc 落盘位置一致）
function wikiGuideDir() {
  return getWikiMode() === 'llm-wiki' ? path.join(WIKI_LLM_DIR, 'sources') : WIKI_STORE_DIR;
}

// 解析 wiki 文档：frontmatter（title/description/tags）+ 正文；容忍缺项与格式差异
function parseWikiDoc(text) {
  const raw = String(text || '');
  const out = { title: '', description: '', tags: [], body: raw };
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return out;
  out.body = raw.slice(m[0].length);
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(title|description|tags)\s*:\s*(.*)$/);
    if (!kv) continue;
    if (kv[1] === 'tags') {
      const t = kv[2].trim();
      const arr = t.match(/^\[(.*)\]$/);
      out.tags = (arr ? arr[1] : t).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    } else {
      out[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return out;
}

// 序列化 wiki 文档：frontmatter 三要素 + 空行 + 正文
function serializeWikiDoc(meta, body) {
  const tags = Array.isArray(meta.tags) ? meta.tags.filter(Boolean) : [];
  return `---\ntitle: ${meta.title || ''}\ndescription: ${meta.description || ''}\ntags: [${tags.join(', ')}]\n---\n\n${body || ''}`;
}

// 扫描轻量文档库：递归（限深 2）*.md，跳过 . 开头目录/文件；withBody 时附带正文（检索用）
// 归属推断：根目录文档 = category 'note' / repoSlug 'default'（既有文档兼容）；
// 子目录文档 = 首段作为仓库 slug（查仓库清单得 category，查不到按 note）；llm-wiki 模式的 sources/ 前缀归默认仓库。
function listWikiDocs(withBody = false) {
  const docs = [];
  const walk = (dir, rel, depth) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of list) {
      if (ent.name.startsWith('.')) continue;
      const relPath = rel ? rel + '/' + ent.name : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < 2) walk(full, relPath, depth + 1);
      } else if (ent.isFile() && /\.md$/i.test(ent.name)) {
        let text = '';
        try { text = fs.readFileSync(full, 'utf8'); } catch (e) { /* 读取失败按空文档处理 */ }
        const meta = parseWikiDoc(text);
        let mtime = null;
        try { mtime = fs.statSync(full).mtime.toISOString(); } catch (e) { /* 取时间失败置空 */ }
        const seg = relPath.split('/');
        let category = 'note';
        let repoSlug = 'default';
        if (seg.length > 1) {
          const first = seg[0];
          if (first !== 'sources' || getWikiMode() !== 'llm-wiki') {
            repoSlug = first;
            const metaRepo = readWikiRepos().find((r) => r.slug === first);
            category = metaRepo ? metaRepo.category : 'note';
          }
        }
        docs.push(Object.assign(
          { relPath, title: meta.title || ent.name.replace(/\.md$/i, ''), description: meta.description, tags: meta.tags, category, repoSlug, mtime },
          withBody ? { body: meta.body } : null
        ));
      }
    }
  };
  walk(WIKI_STORE_DIR, '', 1);
  return docs;
}

// ---------- Wiki 仓库清单（data/wiki/repos.json 持久化；内置「本地文档库」恒在） ----------
const WIKI_REPOS_FILE = path.join(WIKI_STORE_DIR, 'repos.json');
const WIKI_BUILTIN_REPO = { category: 'note', slug: 'default', name: '本地文档库' };
const WIKI_CATEGORIES = ['material', 'note', 'agent-doc', 'experience', 'archive'];
function readWikiRepos() {
  try {
    const j = JSON.parse(fs.readFileSync(WIKI_REPOS_FILE, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch (e) { return []; }
}
function writeWikiRepos(repos) {
  try {
    fs.mkdirSync(WIKI_STORE_DIR, { recursive: true });
    fs.writeFileSync(WIKI_REPOS_FILE, JSON.stringify(repos, null, 2), 'utf8');
  } catch (e) { /* 写入失败不阻塞（仓库为展示元数据） */ }
}
function wikiRepoList() {
  // 内置仓库 + 用户仓库（内置恒在前；重名/重 slug 以用户列表为准去重）
  const user = readWikiRepos().filter((r) => r && r.slug && r.slug !== 'default');
  return [WIKI_BUILTIN_REPO, ...user].map((r) => ({ ...r, mode: getWikiMode() }));
}

// 解析文档库相对路径 → 绝对路径（防目录穿越：resolve 后必须仍在 WIKI_STORE_DIR 内）
function resolveWikiFile(rel) {
  const full = path.resolve(WIKI_STORE_DIR, String(rel || ''));
  if (full !== WIKI_STORE_DIR && !full.startsWith(WIKI_STORE_DIR + path.sep)) return null;
  return full;
}

// ---------- Wiki 知识图谱构建（轻量、无外部依赖） ----------
// 图模型：document / section 两类节点；边含 contains（文档含章节）、part_of（章节属文档）、
// mentions（文档正文提及另一文档标题 → 跨文档引用关系）。图谱按 (category, repo) 缓存，
// 并以「文档集合指纹」（relPath + mtime）失效：新建/编辑文档后自动重建。
const wikiGraphCache = new Map(); // "cat/repo" → {nodes, edges, fp}
const GRAPH_MAX_NODES = 400;      // 节点总数上限（防大文档库膨胀）
const GRAPH_MAX_SECTIONS = 24;    // 单文档章节节点上限（长文档自动拆章节）
const GRAPH_MIN_MENTION_LEN = 4;  // 跨文档提及的标题最短长度（避免短标题误匹配）

// 文档集合指纹：relPath + mtime（不读正文，开销小）
function wikiDocsFingerprint() {
  return listWikiDocs().map((d) => `${d.relPath}:${d.mtime || ''}`).join('|');
}

// 提取 markdown 标题（# 至 ####），去重并剥离行内符号
function extractMarkdownHeadings(text) {
  const out = [];
  const seen = new Set();
  const re = /^#{1,4}\s+(.+)$/gm;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const raw = m[1].trim();
    const h = raw.replace(/[*_`[\]()<>#]/g, '').trim();
    if (!h || h.length > 60) continue;
    const key = h.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= GRAPH_MAX_SECTIONS) break;
  }
  return out;
}

// 构建图谱：返回 {nodes, edges}（nodes 按 id 去重）
// 图谱严格按 (category, repo) 隔离：只构建该仓库的文档（不同仓库间无节点、无提及边）
function buildWikiGraph(category, repo) {
  const docs = listWikiDocs(true).filter((d) => d.category === category && d.repoSlug === repo); // 带正文（frontmatter 已在 parseWikiDoc 剥离）
  const nodes = [];
  const edges = [];
  const nodeIds = new Set();
  const edgeSeen = new Set();
  const pushNode = (n) => {
    if (nodeIds.has(n.id)) return;
    nodeIds.add(n.id);
    nodes.push(n);
  };
  const pushEdge = (subject, object, predicate) => {
    if (subject === object) return;
    const key = subject + '\u0000' + predicate + '\u0000' + object;
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push({ subject, object, predicate, confidence: 1 });
  };
  const full = () => nodes.length >= GRAPH_MAX_NODES;

  // 1) 文档节点 + 章节节点（长文档自动拆章节为图谱节点）+ contains/part_of 层级边
  const docIdByPath = new Map();
  for (const d of docs) {
    if (full()) break;
    const id = 'doc:' + d.relPath;
    docIdByPath.set(d.relPath, id);
    pushNode({ id, node_type: 'document', title: d.title || d.relPath, path: d.relPath });
  }
  for (const d of docs) {
    if (full()) break;
    const docId = docIdByPath.get(d.relPath);
    if (!docId) continue;
    for (const h of extractMarkdownHeadings(d.body)) {
      if (full()) break;
      const sid = 'sec:' + d.relPath + '#' + h;
      pushNode({ id: sid, node_type: 'section', title: h, path: d.relPath + '#' + h });
      pushEdge(docId, sid, 'contains');
      pushEdge(sid, docId, 'part_of');
    }
  }
  // 2) 跨文档 mentions：文档正文提及另一文档标题（长度 ≥ 4 才判定，避免短标题误匹配）
  const titleToDoc = new Map();
  for (const d of docs) {
    const t = (d.title || '').trim();
    if (t.length >= GRAPH_MIN_MENTION_LEN) titleToDoc.set(t.toLowerCase(), 'doc:' + d.relPath);
  }
  for (const d of docs) {
    if (full()) break;
    const docId = 'doc:' + d.relPath;
    const lower = (d.body || '').toLowerCase();
    for (const [t, target] of titleToDoc) {
      if (target === docId) continue;
      if (lower.includes(t)) pushEdge(docId, target, 'mentions');
    }
  }
  return { nodes, edges };
}

// 读取（或懒构建）图谱数据：指纹未变走缓存；文档集合变化 / force 时重建
function wikiGraphData(category, repo, force = false) {
  const key = String(category || 'note') + '/' + String(repo || 'default');
  const fp = wikiDocsFingerprint();
  const hit = wikiGraphCache.get(key);
  if (!force && hit && hit.fp === fp) return hit;
  const g = buildWikiGraph(category, repo);
  const entry = { nodes: g.nodes, edges: g.edges, fp };
  if (wikiGraphCache.size >= 20) wikiGraphCache.clear(); // 防内存膨胀
  wikiGraphCache.set(key, entry);
  return entry;
}

// 任务目录文件树扫描：限深 4、跳过 . 开头目录；返回 {entries, fileCount, size}
function scanTreeDir(dir, depth) {
  const out = { entries: [], fileCount: 0, size: 0 };
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of list) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name.startsWith('.')) continue;
      const child = { name: ent.name, type: 'dir', size: 0, children: [] };
      if (depth < 4) {
        const sub = scanTreeDir(full, depth + 1);
        child.children = sub.entries;
        out.fileCount += sub.fileCount;
        out.size += sub.size;
      }
      out.entries.push(child);
    } else if (ent.isFile()) {
      let size = 0;
      try { size = fs.statSync(full).size; } catch (e) { /* 取大小失败按 0 计 */ }
      out.entries.push({ name: ent.name, type: 'file', ext: path.extname(ent.name).slice(1).toLowerCase(), size });
      out.fileCount += 1;
      out.size += size;
    }
  }
  return out;
}

// 拍平 scanTreeDir 嵌套树为文件清单（rel 用正斜杠含子目录）
// 归档文件列表包含任务目录全部可见文件（含 AGENTS.md/MEMORY.md/task.json 系统档案，
// 它们也是该任务的对话产物）；仅排除 . 开头隐藏文件（如 .env），防敏感信息进归档。
// 目录层面的 . 开头目录由 scanTreeDir 跳过（.workbuddy/ 等 dsh 内部状态不进列表）。
function flattenTreeFiles(entries, rel, out) {
  for (const ent of entries || []) {
    const relName = rel ? rel + '/' + ent.name : ent.name;
    if (ent.type === 'dir') {
      flattenTreeFiles(ent.children, relName, out);
    } else if (ent.type === 'file') {
      if (ent.name.startsWith('.')) continue;
      out.push({ name: relName, size: ent.size });
    }
  }
}

// 任务对话产物清单：扫描任务目录（复用 scanTreeDir 递归），
// 返回 [{name,size,sourcePath}]（含系统档案；. 开头隐藏文件与 . 开头目录除外）
function taskArtifactFiles(task) {
  const files = [];
  if (!task || !task.dir || !fs.existsSync(task.dir)) return files;
  flattenTreeFiles(scanTreeDir(task.dir, 1).entries, '', files);
  files.forEach((f) => { f.sourcePath = path.join(task.dir, f.name); });
  return files;
}

function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// 内部调用 dsh 智能体 RPC（envelope 格式）；rpcId 可显式指定（运行期协议兜底重试用 wb-fb- 前缀，供前端去重识别）
function harnessRpc(method, payload = {}, rpcId) {
  return new Promise((resolve, reject) => {
    const id = rpcId || 'wb-srv-' + Math.random().toString(36).slice(2);
    const body = JSON.stringify({ type: 'client-request', rpcId: id, method, payload });
    const req = http.request({
      host: HARNESS_HOST, port: HARNESS_PORT, path: '/api/' + method, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const env = JSON.parse(data);
          if (env.result && env.result.ok) resolve(env.result.value);
          else reject(new Error((env.result && env.result.error && (env.result.error.message || env.result.error.code)) || 'RPC failed'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', (e) => { reviveHarness(); reject(e); });
    req.end(body);
  });
}

// ---------- 运行期协议兜底（方案 A）：首次对话遇协议相关 4xx → 临时降级 Completions 重试一次 ----------
// 背景：通用兼容模式在「配置期」用 probeResponsesSupport 预判端点是否支持 Responses API，
// 但配置期判定可能在真实对话时失准（端点行为变化/探测盲区）。本机制在运行期兜底：
//   首次对话 turn/end 出现协议相关错误（404 路由不存在 / 405 / 501）时，
//   将对应 provider 路由临时降级为 openai-completions 并原样重发一次 prompt。
// 判定矩阵（仅以下触发降级，其余一律不触发）：
//   触发：404 且错误体不含模型信号（裸 Not Found=路由不存在）、405、501
//   不触发：401/403/429/5xx（网络/鉴权/排队/维护）、400/422（载荷/未知参数）、
//           404 model-not-found（路由存在仅模型未知，降级无意义）、超时、连接失败
// 不持久化：降级仅存于网关内存态（protoOverrides），优雅关闭时统一恢复原协议，网关不落盘任何降级记录。
const protoOverrides = new Map();   // route → { originalApi }（运行期确证 Responses 不可用，改用 Completions）
const fallbackWatchers = new Map(); // sessionId → watcher（观察首次对话 turn 结果）
const FALLBACK_POLL_MS = 2000;
const FALLBACK_DEADLINE_MS = 120000;
const FALLBACK_RETRY_PREFIX = 'wb-fb-'; // 网关重试 session.prompt 的 rpcId 前缀（前端据此去重重试回显的用户气泡）

// 判定错误消息是否为「协议不支持」信号（与 probeResponsesSupport / 前端 isProtocolFallbackErr 保持同一套口径）
function isProtocolFallbackError(msg) {
  const m = String(msg || '');
  const st = m.match(/\((\d{3})\)/);
  if (!st) return false;
  const status = Number(st[1]);
  if (status === 405 || status === 501) return true;
  if (status === 404) {
    const idx = m.indexOf('):');
    const raw = idx >= 0 ? m.slice(idx + 2) : m;
    const modelish = /\bmodel\b|model_not_found|does not exist|no such|unknown model/i.test(raw);
    return !modelish; // 裸 404（路由不存在）→ 触发；404 model-not-found（路由存在）→ 不触发
  }
  return false;
}

// 获取会话当前 provider 路由（session.models 的 current.provider）
async function sessionCurrentRoute(sessionId) {
  try {
    const m = await harnessRpc('session.models', { sessionId });
    const cur = m && m.current;
    return (cur && cur.provider) || null;
  } catch (e) { return null; }
}

// 将 route 临时降级为 openai-completions（仅对 api=openai-responses 的路由生效；已降级则跳过）
// 返回是否成功切换。切换后记录到 protoOverrides（内存态），优雅关闭统一恢复。
// 注意：不得仅凭 protoOverrides.has(route) 短路——同生命周期内路由可能被重新保存回 responses，
// 故每次先核对当前 profile 的 api 字段再决定是否需要再次 mutate。
async function downgradeRouteToCompletions(route) {
  try {
    const d = await harnessRpc('settings.describe', {});
    const piNs = (d.namespaces || []).find((n) => n.ns === 'llm-pi-ai');
    const profile = (piNs && piNs.value && piNs.value.providers && piNs.value.providers[route]) || null;
    if (!profile) return false;
    const api = String(profile.api || '');
    if (api === 'openai-completions') {
      // 已在降级态：补记覆盖（应对「已降级后被重新保存为 responses 再触发」的恢复锚点）
      if (!protoOverrides.has(route)) protoOverrides.set(route, { originalApi: 'openai-responses' });
      return true;
    }
    if (api !== 'openai-responses') return false; // 仅降级 Responses 协议路由；Completions/官方适配器无备用协议可降
    await harnessRpc('settings.mutate', {
      ns: 'llm-pi-ai',
      ops: [{ op: 'set', path: ['providers', route, 'api'], value: 'openai-completions' }],
      expectedRevision: piNs.revision
    });
    if (!protoOverrides.has(route)) protoOverrides.set(route, { originalApi: api });
    return true;
  } catch (e) { return false; }
}

// 观察会话首次对话的 turn 结果：协议 4xx → 降级重试一次；成功/非协议错误 → 结束观察
function watchSessionFallback(sessionId, payload) {
  if (fallbackWatchers.has(sessionId)) return;
  const w = {
    sessionId, payload,
    retried: false,      // 是否已降级重试（仅重试一次）
    lastTurn: 0,         // 已处理的最大 turn 号
    timer: null, deadline: null
  };
  w.timer = setInterval(() => pollSessionFallback(w).catch(() => {}), FALLBACK_POLL_MS);
  if (w.timer.unref) w.timer.unref();
  w.deadline = setTimeout(() => { clearInterval(w.timer); fallbackWatchers.delete(sessionId); }, FALLBACK_DEADLINE_MS);
  if (w.deadline.unref) w.deadline.unref();
  fallbackWatchers.set(sessionId, w);
}

function clearSessionFallback(w) {
  clearInterval(w.timer);
  if (w.deadline) clearTimeout(w.deadline);
  fallbackWatchers.delete(w.sessionId);
}

async function pollSessionFallback(w) {
  let h;
  try { h = await harnessRpc('session.history', { sessionId: w.sessionId, maxMessages: 100 }); }
  catch (e) { return; } // 智能体暂不可用：下轮再试
  const entries = Array.isArray(h && h.events) ? h.events : [];
  const ends = [];
  for (const ent of entries) {
    const ev = ent && ent.event ? ent.event : ent;
    if (ev && ev.type === 'turn/end' && ev.data && typeof ev.data.turn === 'number') ends.push(ev);
  }
  if (!ends.length) return;
  const latest = ends.sort((a, b) => b.data.turn - a.data.turn)[0];
  if (latest.data.turn <= w.lastTurn) return; // 已处理过
  w.lastTurn = latest.data.turn;
  const reason = latest.data.reason || {};
  if (w.retried || reason.kind !== 'error') { clearSessionFallback(w); return; } // 重试已完成 / 本轮正常结束
  const msg = (reason.error && (reason.error.message || reason.error.code)) || '';
  if (!isProtocolFallbackError(msg)) { clearSessionFallback(w); return; } // 非协议错误（网络/排队/维护/参数）→ 不触发降级
  // 触发降级：确认路由 → 临时切换 Completions → 原样重发 prompt 一次
  try {
    const route = await sessionCurrentRoute(w.sessionId);
    if (!route || !(await downgradeRouteToCompletions(route))) { clearSessionFallback(w); return; }
    w.retried = true;
    await harnessRpc('session.prompt', w.payload, FALLBACK_RETRY_PREFIX + Math.random().toString(36).slice(2));
    console.log(`[DSH Work Buddy] 运行期协议兜底：${route} 首次对话协议错误(${msg.slice(0, 90)})，已临时降级 Completions 重试`);
  } catch (e) { clearSessionFallback(w); }
}

// 优雅关闭时恢复全部临时降级（不持久化降级结果；1.5s 内尽力完成，失败不阻塞退出）
// 仅恢复仍存在的路由：provider 已被删除（如测试清理）时不再重建，避免残留空壳 provider。
async function restoreProtoOverrides() {
  for (const [route, { originalApi }] of protoOverrides) {
    try {
      const d = await harnessRpc('settings.describe', {});
      const piNs = (d.namespaces || []).find((n) => n.ns === 'llm-pi-ai');
      const profile = (piNs && piNs.value && piNs.value.providers && piNs.value.providers[route]) || null;
      if (!profile) continue; // 路由已不存在 → 无需恢复
      await harnessRpc('settings.mutate', {
        ns: 'llm-pi-ai',
        ops: [{ op: 'set', path: ['providers', route, 'api'], value: originalApi }],
        expectedRevision: piNs && piNs.revision
      });
    } catch (e) { /* 尽力而为 */ }
  }
  protoOverrides.clear();
}

// user/message 事件首文本块（容忍 content 为文本块数组 / 纯字符串 / message.content 三种形态）
function firstUserText(ev) {
  const data = (ev && ev.data) || {};
  let blocks = data.content;
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks) && data.message && Array.isArray(data.message.content)) blocks = data.message.content;
  if (!Array.isArray(blocks)) return '';
  const first = blocks.find((b) => b && b.type === 'text' && typeof b.text === 'string');
  return first ? first.text : '';
}

// 归档会话统计（尽力而为，调用方兜底失败）：
// messages = events 中 type==='user/message' 且首文本块不以 "Current runtime context" 开头的事件数（排除运行时上下文注入）；
// tokens = projections.values.tokenUsage 四项之和（首页快照）；session.history 默认每页 50 条，按 beforeSeq 翻页累加
async function archiveSessionStats(sessionId) {
  let messages = 0;
  let tokens = 0;
  let beforeSeq;
  for (let page = 0; page < 50; page++) { // 翻页上限 50 页，防异常会话拖垮归档
    const payload = { sessionId, maxMessages: 200 };
    if (beforeSeq !== undefined) payload.beforeSeq = beforeSeq;
    const v = await harnessRpc('session.history', payload);
    const entries = Array.isArray(v.events) ? v.events : [];
    for (const ent of entries) {
      const ev = ent && ent.event ? ent.event : ent; // HistoryEntry 包裹或裸事件均容忍
      if (ev && ev.type === 'user/message' && !firstUserText(ev).startsWith('Current runtime context')) messages += 1;
    }
    if (page === 0 && v.projections && v.projections.values && v.projections.values.tokenUsage) {
      const u = v.projections.values.tokenUsage;
      tokens = (u.uncachedInputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0);
    }
    if (!v.hasMore) break;
    const seqs = entries.map((e) => (e && e.event ? e.event.seq : undefined)).filter((s) => typeof s === 'number');
    if (!seqs.length) break;
    beforeSeq = Math.min(...seqs);
  }
  return { messages, tokens };
}

// assistant/message 事件文本（容忍 data.content 文本块 / data.message.content / data.text 多形态）
function assistantText(ev) {
  const data = (ev && ev.data) || {};
  let blocks = data.content;
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks) && data.message && Array.isArray(data.message.content)) blocks = data.message.content;
  if (Array.isArray(blocks)) {
    const t = blocks.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
    if (t) return t;
  }
  if (typeof data.text === 'string' && data.text.trim()) return data.text.trim();
  if (data.message && typeof data.message.text === 'string' && data.message.text.trim()) return data.message.text.trim();
  return '';
}

// 拉取会话完整对话（user/assistant 消息，按时间顺序，上限 500 条防超大会话拖垮归档）
async function fetchSessionConversation(sessionId) {
  const conv = [];
  let beforeSeq;
  for (let page = 0; page < 50 && conv.length < 500; page++) {
    const payload = { sessionId, maxMessages: 200 };
    if (beforeSeq !== undefined) payload.beforeSeq = beforeSeq;
    const v = await harnessRpc('session.history', payload);
    const entries = Array.isArray(v.events) ? v.events : [];
    for (const ent of entries) {
      const ev = ent && ent.event ? ent.event : ent; // HistoryEntry 包裹或裸事件均容忍
      if (!ev || !ev.type || !ev.time) continue;
      if (ev.type === 'user/message') {
        const t = firstUserText(ev);
        if (t && !t.startsWith('Current runtime context')) conv.push({ role: 'user', text: t, time: ev.time });
      } else if (ev.type === 'assistant/message') {
        const t = assistantText(ev);
        if (t) conv.push({ role: 'assistant', text: t, time: ev.time });
      }
      if (conv.length >= 500) break;
    }
    if (!v.hasMore) break;
    const seqs = entries.map((e) => (e && e.event ? e.event.seq : undefined)).filter((s) => typeof s === 'number');
    if (!seqs.length) break;
    beforeSeq = Math.min(...seqs);
  }
  return conv;
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// 文件名搜索（q 已小写）：递归扫描工作区与任务目录的一级子目录（深度≤3，跳过 node_modules/.git，最多 20 条）
// 归属名：工作区文件=data/workspaces 下第一级目录名；任务文件=按 dir 匹配的任务标题（无则'任务文件'）
function searchFiles(q) {
  const LIMIT = 20;
  const results = [];
  const collect = (dir, depth, wsName) => {
    if (depth > 3 || results.length >= LIMIT) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (results.length >= LIMIT) return;
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        collect(full, depth + 1, wsName);
      } else if (ent.isFile() && ent.name.toLowerCase().includes(q)) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch (e) { /* 取大小失败按 0 计 */ }
        results.push({ name: ent.name, wsName, size, path: full });
      }
    }
  };
  try {
    for (const ent of fs.readdirSync(WS_DATA_DIR, { withFileTypes: true })) {
      if (ent.isDirectory()) collect(path.join(WS_DATA_DIR, ent.name), 1, ent.name);
    }
  } catch (e) { /* 工作区目录缺失时跳过 */ }
  const dirTitle = new Map(db.tasks.filter((t) => t.dir).map((t) => [normPath(t.dir), t.title || '任务文件']));
  try {
    for (const ent of fs.readdirSync(TASK_DATA_DIR, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const full = path.join(TASK_DATA_DIR, ent.name);
      collect(full, 1, dirTitle.get(normPath(full)) || '任务文件');
    }
  } catch (e) { /* 任务目录缺失时跳过 */ }
  return results;
}

// 从 dsh 首页 HTML 提取 window.__DSH_BOOT__ 引导 JSON：定位标记后平衡花括号扫描（跳过字符串字面量与转义）
function parseDshBoot(html) {
  const marker = 'window.__DSH_BOOT__';
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  const start = html.indexOf('{', idx + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let strCh = '';
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === strCh) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

// 目录会话（skill.list 需按会话项目根解析）：懒建 + 预分配固定 sessionId 实现重启幂等
let catalogSessionId = null;
async function getCatalogSession() {
  if (catalogSessionId) return catalogSessionId;
  const FIXED_ID = 'session-00000000-0000-4000-8000-0000000000c0';
  try {
    let v;
    try {
      v = await harnessRpc('session.create', { cwd: DATA_DIR, sessionId: FIXED_ID });
    } catch (e) {
      // 预分配 id 与既有会话冲突（cwd 不同）时退回普通创建
      v = await harnessRpc('session.create', { cwd: DATA_DIR });
    }
    catalogSessionId = v.sessionId;
    return catalogSessionId;
  } catch (e) {
    return null;
  }
}

function parseUrl(url) {
  const [p, query] = url.split('?');
  const params = {};
  if (query) {
    query.split('&').forEach((part) => {
      const [k, v] = part.split('=');
      if (k) params[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
    });
  }
  return { path: p, params };
}

// ---------- 模型模态判定（对话窗口图片上传显隐的判定依据） ----------
// harness 无 RPC 可查询模型 inputModalities，且 session.models 不透传该字段；
// 网关侧按与 harness llm-pi-ai 一致的优先级判定「模型是否支持图片输入」：
//   profile 模型级声明（models 条目 input / modelOverrides.input）> pi-ai 内置目录（getBuiltinModels）> profile.defaultInput
// DeepSeek 官方适配器硬编码 inputModalities=['text']（llm-deepseek/src/adapter.ts），永远不支持图片。
let piaiModCache = null; // { mod } | null（懒加载 pi-ai 内置目录；未安装/加载失败为 null）
function resolvePiAiCatalog() {
  if (piaiModCache !== null) return piaiModCache.mod || null;
  piaiModCache = null;
  try {
    // pi-ai 位于 pnpm 虚拟 store：@earendil-works+pi-ai@<hash>/node_modules/@earendil-works/pi-ai
    const pnpmDir = path.join(HARNESS_DIR, 'node_modules', '.pnpm');
    const dirs = fs.readdirSync(pnpmDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^@earendil-works\+pi-ai@/.test(d.name))
      .sort();
    for (const d of dirs) {
      const entry = path.join(pnpmDir, d.name, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'all.js');
      if (fs.existsSync(entry)) {
        try {
          // Node >= 22.19 支持 require(esm)；与智能体同一份 pi-ai 目录数据，判定结果与 harness 一致
          const mod = require(entry);
          if (mod && typeof mod.getBuiltinModels === 'function') { piaiModCache = { mod }; break; }
        } catch (e) { /* 单目录损坏则尝试下一个 */ }
      }
    }
  } catch (e) { /* 未找到 pi-ai（依赖未安装）→ 降级为仅凭配置声明判定 */ }
  return piaiModCache ? piaiModCache.mod : null;
}

const piaiImageIn = (arr) => Array.isArray(arr) && arr.includes('image');

// 判定 provider/model 是否支持图片输入（返回布尔；判定依据缺失时保守返回 false）
function modelSupportsImage(provider, model, piAiValue) {
  const providers = (piAiValue && piAiValue.providers) || {};
  const profile = providers[provider];
  const fromCatalog = () => {
    const mod = resolvePiAiCatalog();
    if (!mod) return null;
    try {
      const list = mod.getBuiltinModels(provider) || [];
      const m = (Array.isArray(list) ? list : []).find((x) => x && x.id === model);
      if (m && Array.isArray(m.input) && m.input.length) return piaiImageIn(m.input);
    } catch (e) { /* 目录查询异常按未声明处理 */ }
    return null;
  };
  if (profile) {
    // 1) 模型级声明（models 条目 + modelOverrides 覆盖；仅当非空数组才采信，与 catalog.ts declaredInput 语义一致）
    const entry = ((profile.models || []).find((m) => m && m.id === model)) || {};
    const override = (profile.modelOverrides && profile.modelOverrides[model]) || {};
    const declared = override.input || entry.input;
    if (Array.isArray(declared) && declared.length) return piaiImageIn(declared);
    // 2) pi-ai 内置目录（目录供应商的视觉模型由目录声明）
    const cat = fromCatalog();
    if (cat !== null) return cat;
    // 3) provider 级默认（本地/自定义端点无目录条目时由用户勾选声明）
    if (Array.isArray(profile.defaultInput) && profile.defaultInput.length) return piaiImageIn(profile.defaultInput);
    return false;
  }
  // provider 未在 llm-pi-ai 配置（deepseek 官方等）：目录兜底，DeepSeek 目录/适配器均为纯文本
  const cat = fromCatalog();
  return cat === true;
}

// 探测远端端点是否支持 OpenAI Responses API：POST {baseURL}/responses（通用兼容模式协议自适应的判定依据）
// 判定规则：
//   - 2xx / 400 / 401 / 403 / 413 / 415 / 422 / 429 / 5xx → 路由存在（错误体是载荷/鉴权/服务级）→ 支持
//   - 404 且错误体提到「模型不存在」（404 model-not-found）→ 路由存在（只是探测模型名未知）→ 支持
//   - 404（其余）/ 405 / 501 → 路由缺失 → 不支持
//   - 网络不可达 / 超时 → supported: null（未知，由前端保守默认 Responses 并提示）
function probeResponsesSupport(baseURL, model) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(String(baseURL || '').replace(/\/+$/, '') + '/responses'); }
    catch (e) { return resolve({ supported: null, status: 0, note: '无效 Base URL' }); }
    const mod = u.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ model: model || '__probe__', input: '' });
    const r = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      timeout: 30000,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer probe', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        const status = res.statusCode;
        const text = data.slice(0, 600);
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { /* 非 JSON 忽略 */ }
        if (status >= 200 && status < 300) return resolve({ supported: true, status, note: '2xx 支持' });
        if (status === 404) {
          // 模型缺失（route 存在）与路由缺失（route 不存在）的区分：
          // 前者错误体含明确的模型信号（"The model ... does not exist" / model_not_found 等），
          // 裸 "Not Found" 仅表示该端点没有 /responses 路由（Completions-only / 无关端点）。
          const raw = (parsed && parsed.error) ? String(parsed.error.message || JSON.stringify(parsed.error)) : text;
          const modelish = /\bmodel\b|model_not_found|does not exist|no such|unknown model/i.test(raw);
          if (modelish) return resolve({ supported: true, status, note: '404 model-not-found（路由存在）' });
          return resolve({ supported: false, status, note: '404 路由不存在' });
        }
        if (status === 405 || status === 501) return resolve({ supported: false, status, note: status + ' 不支持 Responses' });
        return resolve({ supported: true, status, note: '路由存在（' + status + '）' });
      });
    });
    r.on('error', (e) => resolve({ supported: null, status: 0, note: '端点不可达: ' + (e.code || e.message) }));
    r.on('timeout', () => { r.destroy(); resolve({ supported: null, status: 0, note: '探测超时' }); });
    r.end(body);
  });
}

async function handleLocalApi(req, res, urlPath, params) {
  // 智能体同步探测
  if (urlPath === '/api/workspaces/sync-harness' && req.method === 'POST') {
    harnessUp = await probeHarness();
    return sendJson(res, 200, { harnessUp, registered: [], removed: [] });
  }

  // 工作区列表：直连 dsh workspace.list（过滤任务专属目录工作区）
  if (urlPath === '/api/workspaces' && req.method === 'GET') {
    try {
      const v = await harnessRpc('workspace.list', {});
      // 顺带填充工作区路径缓存（任务目录解析 taskDirFor 使用）
      (v.items || []).forEach((w) => { if (w.workspaceId) workspaceCache.set(w.workspaceId, w.path); });
      const workspaces = (v.items || []).filter((w) => !isTaskWorkspace(w.path)).map(mapWorkspace);
      // 每个工作区的任务项目数（按 task.workspaceId 归属统计）与全部任务数，供侧栏「工作区任务数」展示
      const taskCountByWs = {};
      (db.tasks || []).forEach((t) => {
        if (!t.workspaceId) return;
        taskCountByWs[t.workspaceId] = (taskCountByWs[t.workspaceId] || 0) + 1;
      });
      const totalTaskCount = (db.tasks || []).length;
      workspaces.forEach((w) => { w.taskCount = taskCountByWs[w.id] || 0; });
      return sendJson(res, 200, { workspaces, totalTaskCount, harnessUp: true });
    } catch (e) {
      return sendJson(res, 200, { workspaces: [], totalTaskCount: (db.tasks || []).length, harnessUp: false });
    }
  }
  // 新建工作区：在数据目录下 mkdir 后注册为 dsh 工作区（workspace.create 幂等）
  if (urlPath === '/api/workspaces' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!name) return sendJson(res, 400, { error: { message: '工作区名称不能为空' } });
    const safe = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'workspace';
    const dir = path.join(WS_DATA_DIR, safe);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const v = await harnessRpc('workspace.create', { path: dir });
      return sendJson(res, 200, mapWorkspace(v.workspace));
    } catch (e) {
      return sendJson(res, 502, { error: { message: '创建工作区失败：' + e.message } });
    }
  }
  if (urlPath.startsWith('/api/workspaces/') && urlPath.endsWith('/files') && req.method === 'GET') {
    const id = decodeURIComponent(urlPath.split('/')[3] || '');
    // 工作区真实文件扫描：workspaceId → path（缓存 → workspace.list 补齐 → 任务目录兜底），不存在返回 404
    let root = workspaceCache.get(id);
    if (!root) {
      try {
        const v = await harnessRpc('workspace.list', {});
        (v.items || []).forEach((w) => { if (w.workspaceId) workspaceCache.set(w.workspaceId, w.path); });
        root = workspaceCache.get(id);
      } catch (_) { /* 智能体暂不可用：仅用缓存/本地工作区 */ }
    }
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      const task = db.tasks.find((t) => t.workspaceId === id && t.dir);
      root = task && path.dirname(task.dir);
    }
    if (!root || !fs.existsSync(root)) {
      return sendJson(res, 404, { error: { code: 'workspace-not-found', message: '工作区不存在或不可访问' } });
    }
    return sendJson(res, 200, { workspaceId: id, files: workspaceFiles(root) });
  }
  // 删除工作区：仅解除 dsh 注册（磁盘目录与文件保留，与 dsh 语义一致）
  if (urlPath.startsWith('/api/workspaces/') && req.method === 'DELETE') {
    const id = urlPath.split('/').pop();
    try {
      await harnessRpc('workspace.delete', { workspaceId: id });
      db.tasks = db.tasks.filter((t) => t.workspaceId !== id);
      return sendJson(res, 200, { success: true });
    } catch (e) {
      return sendJson(res, 502, { error: { message: '删除工作区失败：' + e.message } });
    }
  }

  if (urlPath === '/api/tasks' && req.method === 'GET') {
    const ws = params.ws;
    // 惰性补齐旧任务目录：dir 为空/目录不存在的，解析并创建（优先工作区目录下）后写回
    for (const t of db.tasks) {
      const hadDir = !!(t.dir && fs.existsSync(t.dir));
      await ensureTaskDir(t);
      // dir 新补 / 目录刚重建（task.json 随之丢失）→ 补落盘持久化
      if (!hadDir && t.dir) saveTaskFile(t);
    }
    let tasks = db.tasks;
    if (ws && ws !== 'all') tasks = tasks.filter((t) => t.workspaceId === ws);
    // 附带工作区任务计数（供侧栏徽标实时刷新，无需单独请求）
    const taskCountByWs = {};
    (db.tasks || []).forEach((t) => {
      if (!t.workspaceId) return;
      taskCountByWs[t.workspaceId] = (taskCountByWs[t.workspaceId] || 0) + 1;
    });
    // 附加会话文件数（右侧智能详情面板「会话内文件数」数据源）：扫描任务目录产物（含系统档案）
    tasks = tasks.map((t) => ({ ...t, fileCount: taskArtifactFiles(t).length }));
    return sendJson(res, 200, { tasks, totalTaskCount: (db.tasks || []).length, taskCountByWs });
  }
  if (urlPath === '/api/tasks' && req.method === 'POST') {
    const body = await readBody(req);
    const id = nextId('t');
    // 任务专属目录：会话隔离的物理边界（ensureHarnessSession 以此注册 harness 工作区）；
    // 绑定工作区时建在工作区目录下（<工作区path>/<taskId>），否则兜底 data/tasks/<id>
    const taskDir = await taskDirFor(id, body.workspaceId || null);
    try { fs.mkdirSync(taskDir, { recursive: true }); } catch (e) { /* 目录创建失败时任务仍可创建 */ }
    const task = {
      id,
      title: body.title || '新任务',
      status: body.status || 'today',
      workspaceId: body.workspaceId || null,
      dir: taskDir,
      deadline: body.deadline || null,
      label: body.label || null,
      createdAt: new Date().toISOString(),
      completedAt: null
    };
    db.tasks.push(task);
    saveTaskFile(task); // 创建即落盘（重启恢复任务与会话关联）
    return sendJson(res, 200, task);
  }
  // 任务文件列表（真实）：递归扫描任务目录，仅列对话产生的文件
  // （排除 AGENTS.md / MEMORY.md / task.json 系统档案与 .workbuddy/ 等 . 开头项）
  if (urlPath.match(/^\/api\/tasks\/[^/]+\/files$/) && req.method === 'GET') {
    const id = urlPath.split('/')[3];
    const task = db.tasks.find((t) => t.id === id);
    if (!task) return sendJson(res, 404, { error: { message: '任务不存在' } });
    return sendJson(res, 200, { files: taskArtifactFiles(task) });
  }
  // 上传文件保存到任务专属目录 uploads/（会话隔离：附件只进当前任务文件夹，不与他任务混放）
  // body: { fileName, encoding: 'base64'|'utf8', data, mediaType? } → 重名自动加序号
  if (urlPath.match(/^\/api\/tasks\/[^/]+\/upload$/) && req.method === 'POST') {
    const id = urlPath.split('/')[3];
    const task = db.tasks.find((t) => t.id === id);
    if (!task) return sendJson(res, 404, { error: { message: '任务不存在' } });
    await ensureTaskDir(task);
    const body = await readBody(req);
    const rawName = String(body.fileName || '').trim();
    const encoding = body.encoding === 'utf8' ? 'utf8' : 'base64';
    const data = String(body.data || '');
    if (!rawName) return sendJson(res, 400, { error: { message: '缺少 fileName' } });
    if (!data) return sendJson(res, 400, { error: { message: '缺少文件内容' } });
    // 文件名消毒：仅取 basename 并剔除危险字符，防目录穿越
    let safe = path.basename(rawName).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
    if (!safe || safe === '.' || safe === '..') safe = 'attachment';
    if (safe.length > 120) { const ext = path.extname(safe); safe = safe.slice(0, Math.max(1, 120 - ext.length)) + ext; }
    const uploadDir = path.join(task.dir, 'uploads');
    try { fs.mkdirSync(uploadDir, { recursive: true }); } catch (e) { return sendJson(res, 500, { error: { message: '创建上传目录失败：' + e.message } }); }
    // 重名自动加序号（1-<name>），避免覆盖既有附件
    let name = safe;
    for (let n = 1; fs.existsSync(path.join(uploadDir, name)); n++) name = `${n}-${safe}`;
    let buf;
    try {
      buf = encoding === 'utf8' ? Buffer.from(data, 'utf8') : Buffer.from(data, 'base64');
    } catch (e) { return sendJson(res, 400, { error: { message: '文件内容解码失败' } }); }
    const MAX_UPLOAD = 16 * 1024 * 1024; // 服务端防御上限 16 MB
    if (buf.length > MAX_UPLOAD) return sendJson(res, 400, { error: { message: '文件过大（上限 16 MB）' } });
    try { fs.writeFileSync(path.join(uploadDir, name), buf); } catch (e) { return sendJson(res, 500, { error: { message: '保存文件失败：' + e.message } }); }
    return sendJson(res, 200, { ok: true, fileName: name, path: `uploads/${name}`, size: buf.length });
  }
  // 任务目录真实文件树：目录缺失 → {tree:null}；存在 → 递归扫描（限深 4，跳过 . 开头目录）
  if (urlPath.match(/^\/api\/tasks\/[^/]+\/tree$/) && req.method === 'GET') {
    const id = urlPath.split('/')[3];
    const task = db.tasks.find((t) => t.id === id);
    if (!task) return sendJson(res, 404, { error: { message: '任务不存在' } });
    let isDir = false;
    try { isDir = !!task.dir && fs.existsSync(task.dir) && fs.statSync(task.dir).isDirectory(); } catch (e) { isDir = false; }
    if (!isDir) return sendJson(res, 200, { tree: null });
    const scanned = scanTreeDir(task.dir, 1);
    return sendJson(res, 200, {
      dirName: path.basename(task.dir),
      entries: scanned.entries,
      stats: { fileCount: scanned.fileCount, size: scanned.size }
    });
  }
  // 会话书架：读取当前任务挂载的 wiki 参考文档
  if (urlPath.match(/^\/api\/tasks\/[^/]+\/docs$/) && req.method === 'GET') {
    const id = urlPath.split('/')[3];
    const task = db.tasks.find((t) => t.id === id);
    if (!task) return sendJson(res, 404, { error: { message: '任务不存在' } });
    return sendJson(res, 200, { shelfDocs: readShelf(task) || [] });
  }
  // 会话书架：挂载文档（relPath 定位，去重后写 shelf.json 并重组 AGENTS.md）
  if (urlPath.match(/^\/api\/tasks\/[^/]+\/docs$/) && req.method === 'POST') {
    const id = urlPath.split('/')[3];
    const task = db.tasks.find((t) => t.id === id);
    if (!task) return sendJson(res, 404, { error: { message: '任务不存在' } });
    const body = await readBody(req);
    const doc = listWikiDocs().find((d) => d.relPath === body.relPath);
    if (!doc) return sendJson(res, 404, { error: { message: '文档不存在：' + (body.relPath || '') } });
    await ensureTaskDir(task);
    const shelf = readShelf(task) || [];
    if (!shelf.some((d) => d.relPath === doc.relPath)) {
      // 只存 文件名/所属分类/所属库名+路径（AGENTS.md 注入用）；库名按当前 wiki 模式判定
      shelf.push({
        relPath: doc.relPath,
        title: doc.title,
        category: doc.category || 'note',
        library: getWikiMode() === 'llm-wiki' ? 'Wiki 知识库' : '本地文档库',
        mtime: doc.mtime
      });
    }
    writeShelfAndAgents(task, shelf);
    return sendJson(res, 200, { success: true, shelfDocs: shelf });
  }
  // 会话书架：卸载文档（按 relPath 过滤移除并重组 AGENTS.md；前端传 relPath，兼容 path）
  if (urlPath.match(/^\/api\/tasks\/[^/]+\/docs$/) && req.method === 'DELETE') {
    const id = urlPath.split('/')[3];
    const task = db.tasks.find((t) => t.id === id);
    if (!task) return sendJson(res, 404, { error: { message: '任务不存在' } });
    const rel = String(params.relPath || params.path || '');
    const shelf = (readShelf(task) || []).filter((d) => d.relPath !== rel);
    writeShelfAndAgents(task, shelf);
    return sendJson(res, 200, { success: true, shelfDocs: shelf });
  }
  // 会话准备：补齐任务目录 + 应用智能体模板 + 落 AGENTS.md / MEMORY.md（dsh 会话以任务目录为 cwd）
  if (urlPath.match(/^\/api\/tasks\/[^/]+\/prepare-session$/) && req.method === 'POST') {
    const id = urlPath.split('/')[3];
    const task = db.tasks.find((t) => t.id === id);
    if (!task) return sendJson(res, 404, { error: { message: '任务不存在' } });
    const body = await readBody(req);
    await ensureTaskDir(task);
    if (body.agentTemplate) {
      task.agentTemplate = Object.assign({}, task.agentTemplate || {}, body.agentTemplate);
    }
    writeTaskAgentFiles(task);
    saveTaskFile(task); // agentTemplate 可能被更新 → 持久化
    return sendJson(res, 200, { task });
  }
  // 会话记忆回传：任务目录 MEMORY.md 覆盖回智能体内置记忆（长期沉淀到 data/agents/<tplId>/）
  if (urlPath.match(/^\/api\/tasks\/[^/]+\/sync-memory$/) && req.method === 'POST') {
    const id = urlPath.split('/')[3];
    const task = db.tasks.find((t) => t.id === id);
    const srcFile = task && task.dir ? path.join(task.dir, 'MEMORY.md') : null;
    if (!srcFile || !fs.existsSync(srcFile)) return sendJson(res, 200, { success: false });
    try {
      const destFile = agentMemoryFile((task.agentTemplate && task.agentTemplate.id) || '_default');
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      fs.writeFileSync(destFile, fs.readFileSync(srcFile, 'utf8'), 'utf8');
      return sendJson(res, 200, { success: true });
    } catch (e) {
      return sendJson(res, 200, { success: false });
    }
  }
  // 任务更新（通用 PATCH：置于具体子路由之后匹配）
  if (urlPath.startsWith('/api/tasks/') && req.method === 'PATCH') {
    const id = urlPath.split('/')[3];
    const body = await readBody(req);
    const task = db.tasks.find((t) => t.id === id);
    if (task) {
      if (body.action === 'ensureDir') await ensureTaskDir(task);
      // 完成会话：complete 信号 → 置完成态并记录完成时间（空则记当前时间）；
      // renew 续期不动 status（deadline 交给下方 Object.assign 落字段）
      if (body.action === 'complete') {
        task.status = 'completed';
        if (!task.completedAt) task.completedAt = new Date().toISOString();
      }
      // 绑定会话：前端传 {action:'bindSession', snapshot, sessionId}。
      // 前端读取的是 task.sessionSnapshot，需显式落该字段，避免 Object.assign 错落到 task.snapshot 导致
      // 再次进入时快照丢失、会话被重复创建（历史丢失）。
      if (body.action === 'bindSession') {
        task.sessionSnapshot = body.snapshot;
        if (body.sessionId) task.sessionId = body.sessionId;
        if (!task.openedAt) task.openedAt = new Date().toISOString(); // 首次绑定会话时间（详情面板「会话创建时间」数据源）
      }
      // 续期：按新 deadline 重算 status（逾期 → 未逾期恢复为 today；已完成保持 completed）
      if (body.action === 'renew') {
        const dl = body.deadline ? new Date(body.deadline) : null;
        task.deadline = body.deadline;
        delete body.deadline; // 已显式落 deadline，避免 Object.assign 重复覆盖（值一致，仅防后续语义漂移）
        if (task.status !== 'completed') {
          task.status = (dl && dl.getTime() <= Date.now()) ? 'overdue' : 'today';
          task.completedAt = null;
        }
      }
      delete body.action; // 信号字段不落库
      delete body.snapshot; // 已显式映射到 sessionSnapshot
      Object.assign(task, body);
      if (body.status === 'completed' && !task.completedAt) task.completedAt = new Date().toISOString();
      if (body.status && body.status !== 'completed') task.completedAt = null;
      // 更换智能体身份后立即重组任务目录的 AGENTS.md（目录已就位时；书架随读随组）
      if (body.agentTemplate && task.dir && fs.existsSync(task.dir)) writeTaskAgentFiles(task);
      saveTaskFile(task); // 任何变更后持久化（含 bindSession / complete / agentTemplate / renew）
    }
    return sendJson(res, 200, task || {});
  }
  // 删除任务（通用 DELETE：置于具体子路由之后匹配，避免误吞 /docs 等子路由的 DELETE）
  if (urlPath.startsWith('/api/tasks/') && req.method === 'DELETE') {
    const id = urlPath.split('/')[3];
    const task = db.tasks.find((t) => t.id === id);
    db.tasks = db.tasks.filter((t) => t.id !== id);
    // 删除任务时同步删除整个任务目录（task.json / AGENTS.md / 会话产物一并清理）；
    // data/archive 中的归档目录独立保留，不受任务删除影响
    if (task && task.dir) {
      try { fs.rmSync(task.dir, { recursive: true, force: true }); } catch (e) { console.warn('[DSH Work Buddy] 删除任务目录失败：', e.message); }
    }
    return sendJson(res, 200, { success: true });
  }

  // 归档组列表（真实）：扫描 data/archive/<组>/ 下所有 */manifest.json 按组聚合；
  // 组顺序：groups.json 定义的组在前（含无归档的空组），磁盘多出的组随后（id 加 disk_ 前缀供归档定位）
  if (urlPath === '/api/archive/groups' && req.method === 'GET') {
    const diskGroups = new Map(); // 磁盘组目录名 → 会话 manifest 数组
    let level1 = [];
    try { level1 = fs.readdirSync(ARCHIVE_DIR, { withFileTypes: true }); } catch (e) { /* 目录缺失 → 空列表 */ }
    for (const gEnt of level1) {
      if (!gEnt.isDirectory() || gEnt.name.startsWith('.')) continue;
      const sessions = [];
      let level2 = [];
      try { level2 = fs.readdirSync(path.join(ARCHIVE_DIR, gEnt.name), { withFileTypes: true }); } catch (e) { /* 跳过该组 */ }
      for (const sEnt of level2) {
        if (!sEnt.isDirectory()) continue;
        try {
          const m = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, gEnt.name, sEnt.name, 'manifest.json'), 'utf8'));
          if (m && m.taskId) sessions.push(m);
        } catch (e) { /* 无 manifest / 损坏 → 跳过该会话目录 */ }
      }
      diskGroups.set(gEnt.name, sessions);
    }
    const groups = [];
    const seen = new Set(); // 磁盘目录名去重（组名安全化后同名视为同组）
    for (const g of db.archiveGroups) {
      const dirName = safeName(g.name, '归档组');
      if (seen.has(dirName)) continue;
      seen.add(dirName);
      groups.push({ id: g.id, name: g.name, sessions: diskGroups.get(dirName) || [] });
    }
    for (const [dirName, sessions] of diskGroups) {
      if (seen.has(dirName)) continue;
      seen.add(dirName);
      groups.push({ id: 'disk_' + dirName, name: dirName, sessions });
    }
    return sendJson(res, 200, { groups });
  }
  // 新建归档组：内存追加 + groups.json 落盘（含无归档的空组）
  if (urlPath === '/api/archive/groups' && req.method === 'POST') {
    const body = await readBody(req);
    const group = { id: nextId('ag'), name: body.name || '归档组' };
    db.archiveGroups.push(group);
    saveArchiveGroups();
    return sendJson(res, 200, group);
  }
  // 归档会话：复制任务产物到 data/archive/<组>/<任务>/ 并写 manifest.json
  if (urlPath === '/api/archive/sessions' && req.method === 'POST') {
    const body = await readBody(req);
    const task = db.tasks.find((t) => t.id === body.taskId);
    if (!task) return sendJson(res, 404, { error: { message: '任务不存在' } });
    // 组定位：groupId 优先按 id 匹配；再按 name 匹配（前端归档下拉 option value 为组名）；
    // 磁盘组（disk_ 前缀）解析目录名兜底；均未命中才回退默认组
    const group = db.archiveGroups.find((g) => g.id === body.groupId)
      || db.archiveGroups.find((g) => g.name === body.groupId);
    let groupName = group && group.name;
    if (!groupName && typeof body.groupId === 'string' && body.groupId.startsWith('disk_')) groupName = body.groupId.slice(5);
    if (!groupName) groupName = '默认组';
    // 归档目录：data/archive/<组名安全化>/<任务标题安全化 + '_' + 任务 id 后 6 位>/
    const archiveDir = path.join(
      ARCHIVE_DIR,
      safeName(groupName, '归档组'),
      safeName(task.title || '未命名任务', '未命名任务') + '_' + String(task.id).slice(-6)
    );
    // 待复制清单：'all' → 任务产物全部；数组 → 逐个校验 sourcePath（resolve 后必须仍在 task.dir 内，防穿越）；[] → 仅归档元数据
    const toCopy = [];
    if (body.files === 'all') {
      toCopy.push(...taskArtifactFiles(task));
    } else if (Array.isArray(body.files)) {
      const dirNorm = normPath(task.dir);
      for (const f of body.files) {
        const src = path.resolve(String((f && f.sourcePath) || ''));
        if (!dirNorm || !normPath(src).startsWith(dirNorm + '/')) continue; // 越界路径直接跳过
        // 归档内相对名由服务端按 task.dir 计算（不信任前端 name，杜绝 ../ 注入）
        const rel = path.relative(task.dir, src).split(path.sep).join('/');
        toCopy.push({ name: rel, sourcePath: src });
      }
    }
    // 复制文件（保留子目录结构）；单个失败继续其余
    const copiedFiles = [];
    try {
      fs.mkdirSync(archiveDir, { recursive: true });
      for (const f of toCopy) {
        const dest = path.join(archiveDir, f.name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(f.sourcePath, dest);
        let size = 0;
        try { size = fs.statSync(dest).size; } catch (e) { /* 取大小失败按 0 计 */ }
        copiedFiles.push({ name: f.name, size });
      }
    } catch (e) {
      return sendJson(res, 500, { error: { message: '归档失败：' + e.message } });
    }
    // 会话统计与对话记录（有 sessionId 时尽力而为，失败不阻塞归档）
    let messages = 0;
    let tokens = 0;
    let conversation = [];
    if (task.sessionId) {
      try {
        const st = await archiveSessionStats(task.sessionId);
        messages = st.messages;
        tokens = st.tokens;
      } catch (e) { /* 统计失败按 0 处理 */ }
      try {
        conversation = await fetchSessionConversation(task.sessionId);
      } catch (e) { /* 对话拉取失败保持空（详情页可实时回源） */ }
    }
    // 智能体简介：模板名 + 角色设定前 60 字；无模板时兜底默认文案
    const tpl = task.agentTemplate;
    const agentIntro = tpl && tpl.name
      ? tpl.name + ' · ' + String(tpl.prompt || '').slice(0, 60)
      : 'DeepSeek 智能体 · dsh 运行时';
    const now = new Date().toISOString();
    const manifest = {
      taskId: task.id,
      title: task.title,
      label: task.label || null,
      startedAt: task.createdAt,
      endedAt: task.completedAt || now,
      agentIntro,
      messages,
      tokens,
      sizeBytes: copiedFiles.reduce((s, f) => s + (f.size || 0), 0),
      fileCount: copiedFiles.length,
      archivedAt: now,
      sessionId: task.sessionId || null,
      files: copiedFiles, // 复制后的清单 [{name,size}]
      conversation // 对话记录 [{role,text,time}]（归档详情「对话记录」数据源）
    };
    try {
      fs.writeFileSync(path.join(archiveDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    } catch (e) {
      return sendJson(res, 500, { error: { message: '写归档清单失败：' + e.message } });
    }
    task.archived = true;
    saveTaskFile(task); // 归档标记持久化
    return sendJson(res, 200, { success: true, archived: copiedFiles.length });
  }
  if (urlPath === '/api/archive/sessions' && req.method === 'GET') {
    return sendJson(res, 200, { sessions: [] });
  }
  // 归档详情：group+taskId 定位 manifest → 返回元数据与文件清单（文件内容不返回，前端只展示清单）
// 归档文件按扩展名归类（前端归档详情「文件分类」区数据源：{name, count, files:[{name,ext,sizeBytes,path}]}）
function archiveFileCategories(files) {
  const groups = new Map();
  for (const f of files || []) {
    const name = String((f && f.name) || '');
    if (!name) continue;
    const ext = path.extname(name).slice(1).toUpperCase() || '其他';
    if (!groups.has(ext)) groups.set(ext, { name: ext, files: [] });
    groups.get(ext).files.push({ name, ext, sizeBytes: (f.size != null ? f.size : 0), path: name });
  }
  return [...groups.values()].sort((a, b) => b.files.length - a.files.length)
    .map((g) => ({ name: g.name, count: g.files.length, files: g.files }));
}

// 定位归档会话目录（group + taskId → 会话目录绝对路径；未找到返回 null）
function findArchiveSessionDir(groupName, taskId) {
  const groupDir = path.join(ARCHIVE_DIR, safeName(groupName, '归档组'));
  try {
    for (const ent of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      let m = null;
      try { m = JSON.parse(fs.readFileSync(path.join(groupDir, ent.name, 'manifest.json'), 'utf8')); } catch (e) { continue; }
      if (m && m.taskId === taskId) return { sessionDir: path.join(groupDir, ent.name), manifest: m };
    }
  } catch (e) { /* 组目录缺失 */ }
  return null;
}

  if (urlPath === '/api/archive/detail' && req.method === 'GET') {
    const groupName = String(params.group || '');
    const taskId = String(params.taskId || '');
    if (!groupName || !taskId) return sendJson(res, 400, { error: { message: '缺少 group / taskId 参数' } });
    const found = findArchiveSessionDir(groupName, taskId);
    if (!found) return sendJson(res, 404, { error: { message: '归档不存在' } });
    const manifest = found.manifest;
    const sessionDir = found.sessionDir;
    // 对话记录：优先用归档时保存的 manifest.conversation；旧归档无该字段时，
    // 若 harness 会话仍存在则实时回源一次并回写 manifest（尽力而为，失败返回空）
    let conversation = Array.isArray(manifest.conversation) ? manifest.conversation : [];
    if (!conversation.length && manifest.sessionId) {
      try {
        conversation = await fetchSessionConversation(manifest.sessionId);
        if (conversation.length) {
          manifest.conversation = conversation;
          try { fs.writeFileSync(path.join(sessionDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8'); } catch (e) { /* 回写失败忽略 */ }
        }
      } catch (e) { /* 回源失败保持空 */ }
    }
    const files = (manifest.files || []).map((f) => ({ name: f.name, size: f.size, path: f.name }));
    return sendJson(res, 200, {
      group: groupName,
      taskId: manifest.taskId,
      title: manifest.title,
      label: manifest.label || null,
      startedAt: manifest.startedAt,
      endedAt: manifest.endedAt,
      archivedAt: manifest.archivedAt,
      agentIntro: manifest.agentIntro,
      tokens: manifest.tokens,
      messages: manifest.messages,
      sizeBytes: manifest.sizeBytes,
      sessionId: manifest.sessionId || null,
      files,
      categories: archiveFileCategories(manifest.files), // 前端「文件分类」区数据源（按扩展名分组）
      conversation
    });
  }
  // 归档文件内容：group + taskId + name（相对会话目录，防目录穿越）定位并返回（inline 预览 / download 下载）
  if (urlPath === '/api/archive/file' && req.method === 'GET') {
    const groupName = String(params.group || '');
    const taskId = String(params.taskId || '');
    const name = String(params.name || '');
    if (!groupName || !taskId || !name) return sendJson(res, 400, { error: { message: '缺少 group / taskId / name 参数' } });
    const found = findArchiveSessionDir(groupName, taskId);
    if (!found) return sendJson(res, 404, { error: { message: '归档不存在' } });
    const full = path.resolve(found.sessionDir, name);
    if (full !== found.sessionDir && !full.startsWith(found.sessionDir + path.sep)) {
      return sendJson(res, 403, { error: { message: '非法文件路径' } });
    }
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) return sendJson(res, 404, { error: { message: '文件不存在' } });
      const ext = path.extname(full).toLowerCase();
      const ct = mime[ext] || 'application/octet-stream';
      const base = path.basename(full);
      if (String(params.download) === '1') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(base)}` });
      } else {
        res.writeHead(200, { 'content-type': ct, 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(base)}` });
      }
      fs.createReadStream(full).pipe(res);
    } catch (e) {
      return sendJson(res, 404, { error: { message: '文件不存在' } });
    }
  }

  // ---------- Wiki 轻量文档库端点（mode 路由置于块首，均为精确匹配不会被前缀路由截获） ----------
  if (urlPath === '/api/wiki/mode' && req.method === 'GET') {
    return sendJson(res, 200, { mode: getWikiMode() });
  }
  if (urlPath === '/api/wiki/mode' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.mode !== 'lite' && body.mode !== 'llm-wiki') {
      return sendJson(res, 400, { error: { message: 'mode 仅支持 lite / llm-wiki' } });
    }
    try {
      setWikiMode(body.mode);
      return sendJson(res, 200, { mode: body.mode });
    } catch (e) {
      return sendJson(res, 500, { error: { message: '写入 wiki 模式失败：' + e.message } });
    }
  }
  if (urlPath === '/api/wiki/docs' && req.method === 'GET') {
    return sendJson(res, 200, { docs: listWikiDocs() });
  }
  if (urlPath === '/api/wiki/doc' && req.method === 'GET') {
    const full = resolveWikiFile(params.path);
    if (!full) return sendJson(res, 403, { error: { message: '非法文档路径' } });
    try {
      return sendJson(res, 200, { content: fs.readFileSync(full, 'utf8') });
    } catch (e) {
      return sendJson(res, 404, { error: { message: '文档不存在' } });
    }
  }
  if (urlPath === '/api/wiki/doc' && req.method === 'POST') {
    const body = await readBody(req);
    const title = String(body.title || '').trim();
    const description = String(body.description || '').trim();
    const tags = (Array.isArray(body.tags) ? body.tags : []).map((t) => String(t).trim()).filter(Boolean);
    if (!title) return sendJson(res, 400, { error: { message: 'title（名称）不能为空' } });
    if (!description) return sendJson(res, 400, { error: { message: 'description（简介）不能为空' } });
    if (tags.length < 3) return sendJson(res, 400, { error: { message: 'tags（标签）至少 3 个' } });
    const safe = title.replace(/[\\/:*?"<>|\r\n\t]/g, '').trim().slice(0, 80) || 'untitled';
    try {
      const content = serializeWikiDoc({ title, description, tags }, body.content || '');
      if (getWikiMode() === 'llm-wiki') {
        // llm-wiki 模式：写入 sources/ 并确保 SCHEMA.md / index.md 骨架（存在则不覆盖）
        const srcDir = path.join(WIKI_LLM_DIR, 'sources');
        fs.mkdirSync(srcDir, { recursive: true });
        fs.writeFileSync(path.join(srcDir, safe + '.md'), content, 'utf8');
        const schemaFile = path.join(WIKI_LLM_DIR, 'SCHEMA.md');
        if (!fs.existsSync(schemaFile)) fs.writeFileSync(schemaFile, LLM_WIKI_SCHEMA_MD, 'utf8');
        const indexFile = path.join(WIKI_LLM_DIR, 'index.md');
        if (!fs.existsSync(indexFile)) fs.writeFileSync(indexFile, LLM_WIKI_INDEX_MD, 'utf8');
        return sendJson(res, 200, { relPath: 'sources/' + safe + '.md', title });
      }
      // lite 模式：写入轻量文档库根目录
      fs.mkdirSync(WIKI_STORE_DIR, { recursive: true });
      fs.writeFileSync(path.join(WIKI_STORE_DIR, safe + '.md'), content, 'utf8');
      return sendJson(res, 200, { relPath: safe + '.md', title });
    } catch (e) {
      return sendJson(res, 500, { error: { message: '保存文档失败：' + e.message } });
    }
  }
  // 文档创建（前端契约：/api/wiki/write，携带 category + repo，落盘归仓）
  if (urlPath === '/api/wiki/write' && req.method === 'POST') {
    const body = await readBody(req);
    const title = String(body.title || '').trim();
    const description = String(body.description || '').trim();
    const tags = (Array.isArray(body.tags) ? body.tags : []).map((t) => String(t).trim()).filter(Boolean);
    if (!title) return sendJson(res, 400, { error: { message: 'title（名称）不能为空' } });
    if (!description) return sendJson(res, 400, { error: { message: 'description（简介）不能为空' } });
    if (tags.length < 3) return sendJson(res, 400, { error: { message: 'tags（标签）至少 3 个' } });
    const category = String(body.category || 'note');
    let repoSlug = String(body.repo || 'default').trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(repoSlug) || repoSlug === 'default') repoSlug = 'default';
    const safe = title.replace(/[\\/:*?"<>|\r\n\t]/g, '').trim().slice(0, 80) || 'untitled';
    try {
      const content = serializeWikiDoc({ title, description, tags }, body.content || '');
      if (getWikiMode() === 'llm-wiki') {
        // llm-wiki 模式：写入 sources/ 并确保 SCHEMA.md / index.md 骨架（存在则不覆盖）
        const srcDir = path.join(WIKI_LLM_DIR, 'sources');
        fs.mkdirSync(srcDir, { recursive: true });
        fs.writeFileSync(path.join(srcDir, safe + '.md'), content, 'utf8');
        const schemaFile = path.join(WIKI_LLM_DIR, 'SCHEMA.md');
        if (!fs.existsSync(schemaFile)) fs.writeFileSync(schemaFile, LLM_WIKI_SCHEMA_MD, 'utf8');
        const indexFile = path.join(WIKI_LLM_DIR, 'index.md');
        if (!fs.existsSync(indexFile)) fs.writeFileSync(indexFile, LLM_WIKI_INDEX_MD, 'utf8');
        return sendJson(res, 200, { relPath: 'sources/' + safe + '.md', title });
      }
      // lite 模式：归属仓库 → data/wiki/<repoSlug>/<title>.md（default 存根目录，兼容既有文档）
      const dir = repoSlug === 'default' ? WIKI_STORE_DIR : path.join(WIKI_STORE_DIR, repoSlug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, safe + '.md'), content, 'utf8');
      const relPath = repoSlug === 'default' ? safe + '.md' : repoSlug + '/' + safe + '.md';
      return sendJson(res, 200, { relPath, title });
    } catch (e) {
      return sendJson(res, 500, { error: { message: '保存文档失败：' + e.message } });
    }
  }
  if (urlPath === '/api/wiki/doc' && req.method === 'PUT') {
    // 文档编辑（前端契约）：支持改标题/简介/正文/分类/仓库；仓库变化时自动移动文件
    const body = await readBody(req);
    const oldRel = String(body.path || '').trim();
    const title = String(body.title || '').trim();
    const description = String(body.description || '').trim();
    if (!oldRel) return sendJson(res, 400, { error: { message: '缺少文档路径' } });
    if (!title) return sendJson(res, 400, { error: { message: 'title（名称）不能为空' } });
    if (!description) return sendJson(res, 400, { error: { message: 'description（简介）不能为空' } });
    const oldFull = resolveWikiFile(oldRel);
    if (!oldFull) return sendJson(res, 403, { error: { message: '非法文档路径' } });
    // tags 编辑表单不提供：沿用原文档 frontmatter
    let tags = [];
    try { const oldDoc = parseWikiDoc(fs.readFileSync(oldFull, 'utf8')); tags = oldDoc.tags || []; } catch (e) { /* 读取失败按空 tags */ }
    let repoSlug = String(body.repo || 'default').trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(repoSlug) || repoSlug === 'default') repoSlug = 'default';
    const safe = title.replace(/[\\/:*?"<>|\r\n\t]/g, '').trim().slice(0, 80) || 'untitled';
    try {
      const content = serializeWikiDoc({ title, description, tags }, body.content || '');
      const dir = repoSlug === 'default' ? WIKI_STORE_DIR : path.join(WIKI_STORE_DIR, repoSlug);
      fs.mkdirSync(dir, { recursive: true });
      const newRel = repoSlug === 'default' ? safe + '.md' : repoSlug + '/' + safe + '.md';
      const newFull = resolveWikiFile(newRel);
      fs.writeFileSync(newFull, content, 'utf8');
      // 位置/标题变化时清理旧文件（避免残留副本）
      if (oldFull !== newFull && fs.existsSync(oldFull)) { try { fs.unlinkSync(oldFull); } catch (e) { /* 删除失败不阻塞 */ } }
      return sendJson(res, 200, { relPath: newRel, title });
    } catch (e) {
      return sendJson(res, 500, { error: { message: '保存文档失败：' + e.message } });
    }
  }
  if (urlPath === '/api/wiki/doc' && req.method === 'DELETE') {
    const full = resolveWikiFile(params.path);
    if (!full) return sendJson(res, 403, { error: { message: '非法文档路径' } });
    try {
      fs.unlinkSync(full);
      return sendJson(res, 200, { success: true });
    } catch (e) {
      return sendJson(res, 404, { error: { message: '文档不存在' } });
    }
  }
  // 仓库清单：GET 返回内置 + 用户仓库；POST 创建仓库（name 必填、category 限枚举、slug 自动 repo-N）
  if (urlPath === '/api/wiki/repos' && req.method === 'GET') {
    return sendJson(res, 200, { repos: wikiRepoList() });
  }
  if (urlPath === '/api/wiki/repos' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const category = String(body.category || '').trim();
    if (!name) return sendJson(res, 400, { error: { message: '仓库名称不能为空' } });
    if (!WIKI_CATEGORIES.includes(category)) {
      return sendJson(res, 400, { error: { message: '仓库分类不合法（material/note/agent-doc/experience/archive）' } });
    }
    const repos = readWikiRepos();
    const used = new Set(repos.map((r) => r.slug).filter(Boolean));
    let n = 1;
    let slug = 'repo-' + n;
    while (used.has(slug)) { n++; slug = 'repo-' + n; }
    const repo = { category, slug, name, createdAt: new Date().toISOString() };
    repos.push(repo);
    writeWikiRepos(repos);
    return sendJson(res, 200, { ...repo, mode: getWikiMode() });
  }
  if (urlPath === '/api/wiki/repos' && req.method === 'DELETE') {
    // 删除仓库（用户手动移除）：内置「本地文档库」(default) 恒在不可删；
    // 删除 data/wiki/<slug>/ 整目录（含该仓库全部文档）并从 repos.json 移除；同步清理该仓库图谱缓存。
    const slug = String(params.slug || '').trim();
    if (!slug) return sendJson(res, 400, { error: { message: '缺少仓库 slug' } });
    if (slug === 'default') return sendJson(res, 400, { error: { code: 'builtin-repo-protected', message: '内置仓库「本地文档库」不可删除' } });
    const repos = readWikiRepos();
    const repo = repos.find((r) => r.slug === slug);
    if (!repo) return sendJson(res, 404, { error: { code: 'repo-not-found', message: '仓库不存在：' + slug } });
    const removedDocs = listWikiDocs().filter((d) => d.repoSlug === slug).length;
    try {
      // lite 模式：仓库文档落 data/wiki/<slug>/；llm-wiki 模式 sources/ 归默认仓库（该模式下此处目录通常不存在，忽略即可）
      const repoDir = path.join(WIKI_STORE_DIR, slug);
      if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
      writeWikiRepos(repos.filter((r) => r.slug !== slug));
      // 清理该仓库的知识图谱缓存（按 (category, repo) 隔离，避免残留节点）
      wikiGraphCache.delete(repo.category + '/' + slug);
      return sendJson(res, 200, { success: true, slug, removedDocs });
    } catch (e) {
      return sendJson(res, 500, { error: { message: '删除仓库失败：' + e.message } });
    }
  }
  if (urlPath === '/api/wiki/search' && req.method === 'GET') {
    const q = String(params.q || '').trim().toLowerCase();
    if (!q) return sendJson(res, 200, { results: [] });
    // 全字段匹配（title/tags/description/正文，读文件内容），上限 20
    const results = [];
    for (const d of listWikiDocs(true)) {
      if (results.length >= 20) break;
      const hay = `${d.title}\n${d.description}\n${(d.tags || []).join(' ')}\n${d.body || ''}`.toLowerCase();
      if (hay.includes(q)) results.push({ relPath: d.relPath, title: d.title, description: d.description, tags: d.tags });
    }
    return sendJson(res, 200, { results });
  }
  // ---------- Wiki 知识图谱（真实提取：文档 + 章节节点，contains/part_of 层级 + 跨文档 mentions） ----------
  // 图数据按 (category, repo) 缓存于内存；GET 无缓存时懒构建（文档行关联标记直接依赖 GET，无需先 POST）
  if (urlPath === '/api/wiki/graph' && req.method === 'POST') {
    const body = await readBody(req);
    const cat = String(body.category || 'note');
    const repo = String(body.repo || 'default');
    const g = wikiGraphData(cat, repo, true); // 强制重建
    return sendJson(res, 200, { success: true, nodes: g.nodes.length, edges: g.edges.length });
  }
  if (urlPath === '/api/wiki/graph-data' && req.method === 'GET') {
    const cat = String(params.category || 'note');
    const repo = String(params.repo || 'default');
    const g = wikiGraphData(cat, repo);
    return sendJson(res, 200, { nodes: g.nodes, edges: g.edges });
  }
  if (urlPath === '/api/wiki/graph-query' && req.method === 'POST') {
    const body = await readBody(req);
    const cat = String(body.category || 'note');
    const repo = String(body.repo || 'default');
    const nodeId = String(body.node || '');
    const g = wikiGraphData(cat, repo);
    const out = g.edges.filter((e) => e.subject === nodeId);
    const inE = g.edges.filter((e) => e.object === nodeId);
    return sendJson(res, 200, { neighbors: [{ out, in: inE }] });
  }
  if (urlPath === '/api/wiki/inject-agent-docs' && req.method === 'POST') {
    // 诚实返回：真实遍历所有任务专属目录，幂等注入「llm-wiki 知识库调用说明」。
    // 说明文档固定写入 <任务目录>/.workbuddy/llm-wiki-guide.md（dsh 内部状态目录，不污染对话产物/归档清单）；
    // 已存在的任务目录跳过（幂等），失败项返回 failed 数组。前端契约：{written, skipped, total, failed}。
    let written = 0;
    let skipped = 0;
    const total = db.tasks.length;
    const failed = [];
    for (const task of db.tasks) {
      try {
        if (!task || !task.dir) continue;
        const dir = path.join(task.dir, '.workbuddy');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'llm-wiki-guide.md');
        if (fs.existsSync(file)) { skipped++; continue; }
        fs.writeFileSync(file, LLM_WIKI_GUIDE_MD(), 'utf8');
        written++;
      } catch (e) {
        failed.push({ id: task && task.id, error: e.message });
      }
    }
    return sendJson(res, 200, { success: true, written, skipped, total, failed });
  }

  // 插件 Tab：从 dsh 首页引导数据（window.__DSH_BOOT__.entries）提取浏览器插件清单
  if (urlPath === '/api/resources/plugins' && req.method === 'GET') {
    let plugins = null;
    try {
      const html = await fetch(`http://${HARNESS_HOST}:${HARNESS_PORT}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.text());
      const boot = parseDshBoot(html);
      if (boot && Array.isArray(boot.entries)) {
        plugins = boot.entries
          .filter((e) => e && e.id)
          .map((e) => ({
            id: e.id,
            name: e.id.replace(/^@deepseek-ai\/dsh-/, ''),
            description: 'dsh 智能体运行时插件',
            source: 'harness'
          }));
      }
    } catch (e) { /* fetch 异常走 unavailable 兜底 */ }
    if (!plugins) return sendJson(res, 200, { plugins: [], source: 'unavailable' });
    return sendJson(res, 200, { plugins, source: 'harness' });
  }
  if (urlPath === '/api/resources/plugins/toggle' && req.method === 'POST') {
    // 插件启停尚未实现：诚实返回 501，不再伪装成功
    return sendJson(res, 501, { error: { code: 'not-implemented', message: '插件启停功能尚未实现' } });
  }
  // 技能 Tab：对接 dsh skill.list（按目录会话的项目根解析，懒建 + 固定 sessionId 幂等）
  if (urlPath === '/api/resources/skills' && req.method === 'GET') {
    try {
      const sessionId = await getCatalogSession();
      if (!sessionId) return sendJson(res, 200, { skills: [], source: 'unavailable' });
      const v = await harnessRpc('skill.list', { sessionId });
      const skills = (v.skills || []).map((s) => ({
        id: s.name,
        name: s.name,
        description: s.description || '',
        whenToUse: s.whenToUse || '',
        modelInvocable: s.modelInvocable !== false
      }));
      return sendJson(res, 200, { skills, source: 'harness' });
    } catch (e) {
      return sendJson(res, 200, { skills: [], source: 'unavailable' });
    }
  }
  if (urlPath === '/api/resources/skills/toggle' && req.method === 'POST') {
    // 技能启停尚未实现：诚实返回 501，不再伪装成功
    return sendJson(res, 501, { error: { code: 'not-implemented', message: '技能启停功能尚未实现' } });
  }
  if (urlPath === '/api/resources/agent-templates' && req.method === 'GET') {
    return sendJson(res, 200, { templates: db.agentTemplates });
  }
  if (urlPath === '/api/resources/agent-templates' && req.method === 'POST') {
    const body = await readBody(req);
    const tpl = {
      id: nextId('tpl'),
      name: body.name || '未命名智能体',
      description: body.description || '',
      preset: body.preset || 'standard',
      prompt: body.prompt || '',
      createdAt: new Date().toISOString()
    };
    db.agentTemplates.push(tpl);
    saveAgentTemplates(); // 模板定义落盘，网关重启不丢失
    return sendJson(res, 200, tpl);
  }
  if (urlPath.match(/^\/api\/resources\/agent-templates\/[^/]+$/) && req.method === 'PUT') {
    const id = urlPath.split('/').pop();
    const body = await readBody(req);
    const tpl = db.agentTemplates.find((t) => t.id === id);
    if (!tpl) return sendJson(res, 404, { error: { code: 'template-not-found', message: '智能体模板不存在' } });
    Object.assign(tpl, body);
    saveAgentTemplates();
    return sendJson(res, 200, tpl);
  }
  if (urlPath.match(/^\/api\/resources\/agent-templates\/[^/]+$/) && req.method === 'DELETE') {
    const id = urlPath.split('/').pop();
    if (!db.agentTemplates.some((t) => t.id === id)) {
      return sendJson(res, 404, { error: { code: 'template-not-found', message: '智能体模板不存在' } });
    }
    db.agentTemplates = db.agentTemplates.filter((t) => t.id !== id);
    saveAgentTemplates(); // 同步落盘，重启后删除状态保持
    // 同步删除模板记忆目录（data/agents/<id>/），否则孤儿恢复逻辑会在重启后把已删除模板「复活」。
    // 仅清理 tpl_ 前缀模板目录（id 经 agentMemoryFile 同款清洗防穿越），_default 等系统目录不动。
    if (/^tpl_/.test(id)) {
      try {
        const memDir = path.dirname(agentMemoryFile(id));
        if (memDir !== AGENTS_DATA_DIR && memDir.startsWith(AGENTS_DATA_DIR + path.sep)) {
          fs.rmSync(memDir, { recursive: true, force: true });
        }
      } catch (e) { /* 删除记忆目录失败不阻塞删除操作（孤儿恢复仍可能捞回，下次删除重试） */ }
    }
    return sendJson(res, 200, { success: true });
  }
  // 智能体模板内置记忆（智能体管理页记忆编辑）：读取（懒建）/编辑/重置 data/agents/<id>/MEMORY.md
  if (urlPath.match(/^\/api\/resources\/agent-templates\/[^/]+\/memory$/) && req.method === 'GET') {
    const id = urlPath.split('/')[4];
    return sendJson(res, 200, { content: getAgentMemory(id) });
  }
  if (urlPath.match(/^\/api\/resources\/agent-templates\/[^/]+\/memory$/) && req.method === 'PUT') {
    const id = urlPath.split('/')[4];
    const body = await readBody(req);
    try {
      const file = agentMemoryFile(id);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body.content || '', 'utf8');
      return sendJson(res, 200, { success: true });
    } catch (e) {
      return sendJson(res, 500, { success: false, error: { message: '写入智能体记忆失败：' + e.message } });
    }
  }
  if (urlPath.match(/^\/api\/resources\/agent-templates\/[^/]+\/memory\/reset$/) && req.method === 'POST') {
    const id = urlPath.split('/')[4];
    try {
      const file = agentMemoryFile(id);
      const content = memoryTemplate(new Date().toISOString());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      return sendJson(res, 200, { content });
    } catch (e) {
      return sendJson(res, 500, { error: { message: '重置智能体记忆失败：' + e.message } });
    }
  }

  if (urlPath === '/api/schedule' && req.method === 'GET') {
    return sendJson(res, 200, { events: [] });
  }
  // 顶部全局搜索：任务（标题/label.text）/ 文档（path/content）/ 文件（文件名）三分区，q 不区分大小写
  if (urlPath === '/api/search' && req.method === 'GET') {
    const q = String(params.q || '').trim().toLowerCase();
    if (!q) return sendJson(res, 200, { tasks: [], docs: [], files: [] });
    const tasks = db.tasks
      .filter((t) => (t.title || '').toLowerCase().includes(q) || ((t.label && t.label.text) || '').toLowerCase().includes(q))
      .map((t) => ({ id: t.id, title: t.title, status: t.status, workspaceId: t.workspaceId }));
    // 文档分区：轻量文档库全字段匹配（title/description/tags/正文），上限 20
    const docs = [];
    for (const d of listWikiDocs(true)) {
      if (docs.length >= 20) break;
      const hay = `${d.title}\n${d.description}\n${(d.tags || []).join(' ')}\n${d.body || ''}`.toLowerCase();
      if (hay.includes(q)) docs.push({ relPath: d.relPath, title: d.title, category: 'note', description: d.description });
    }
    return sendJson(res, 200, { tasks, docs, files: searchFiles(q) });
  }
  if (urlPath === '/api/plugin-community' && req.method === 'GET') {
    // 前端契约：{ presets: 预置精选（不可删）, user: 用户自建收藏（可删） }
    return sendJson(res, 200, { presets: PLUGIN_COMMUNITY_SEED, user: db.pluginCommunity });
  }
  if (urlPath === '/api/plugin-community' && req.method === 'POST') {
    const body = await readBody(req);
    const item = { id: nextId('pc'), user: true, ...body };
    db.pluginCommunity.push(item);
    savePluginCommunity(); // 用户收藏落盘，网关重启不丢失
    return sendJson(res, 200, item);
  }
  if (urlPath.startsWith('/api/plugin-community/') && req.method === 'DELETE') {
    const id = urlPath.split('/').pop();
    db.pluginCommunity = db.pluginCommunity.filter((p) => p.id !== id);
    savePluginCommunity(); // 同步落盘，重启后删除状态保持
    return sendJson(res, 200, { success: true });
  }

  // 模型模态判定：GET /api/model-modality?provider=<id>&model=<id> → { provider, model, image }
  // 对话窗口据此决定是否显示图片上传图标（仅支持图片输入的模型才显示）
  if (urlPath === '/api/model-modality' && req.method === 'GET') {
    const provider = String(params.provider || '');
    const model = String(params.model || '');
    if (!provider || !model) return sendJson(res, 400, { ok: false, error: { message: '缺少 provider / model 参数' } });
    try {
      const d = await harnessRpc('settings.describe', {});
      const piNs = (d.namespaces || []).find((n) => n.ns === 'llm-pi-ai');
      const image = modelSupportsImage(provider, model, (piNs && piNs.value) || {});
      return sendJson(res, 200, { provider, model, image });
    } catch (e) {
      // settings 读取失败（智能体未就绪等）→ 保守判定不支持图片
      return sendJson(res, 200, { provider, model, image: false, degraded: true });
    }
  }

  // Responses 协议探测：POST /api/probe-responses { baseURL, model? } → { baseURL, supported, status, note }
  // 通用兼容模式协议自适应：默认优先 Responses，端点不支持时前端自动回退 Completions
  if (urlPath === '/api/probe-responses' && req.method === 'POST') {
    const body = await readBody(req);
    const baseURL = String(body.baseURL || '').trim();
    if (!baseURL) return sendJson(res, 400, { ok: false, error: { message: '缺少 baseURL 参数' } });
    const probe = await probeResponsesSupport(baseURL, body.model ? String(body.model) : '');
    return sendJson(res, 200, { baseURL, supported: probe.supported, status: probe.status, note: probe.note });
  }

  return null; // 未匹配本地路由
}

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  const { path: urlPath, params } = parseUrl(req.url);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 本地 mock 路由
  if (urlPath.startsWith('/api/') && isLocalApi(urlPath)) {
    const handled = await handleLocalApi(req, res, urlPath, params);
    if (handled !== null) return;
  }

  // Wiki 文档库（llm-wiki 构建产物静态托管；须在智能体代理前拦截，否则会被转发到 dsh SPA）
  if (urlPath === '/llm-wiki-plugin' || urlPath.startsWith('/llm-wiki-plugin/')) {
    return serveWiki(urlPath, res, req);
  }

  // 运行期协议兜底：拦截 session.prompt —— 读取 envelope（供失败重试原样重发），转发后观察首次对话结果
  if (urlPath === '/api/session.prompt' && req.method === 'POST') {
    const env = await readBody(req); // readBody 已 JSON.parse → env 即信封对象
    const payload = (env && env.payload) || null;
    const sid = payload && payload.sessionId;
    const rawJson = JSON.stringify(env); // 原样重发需要字符串体
    // 与 proxyHttp 一致：转发到智能体（服务端到服务端，不携带浏览器 Origin，dsh 连接围栏不受影响）
    const preq = http.request({
      host: HARNESS_HOST, port: HARNESS_PORT, path: '/api/session.prompt', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rawJson) }
    }, (pres) => {
      res.writeHead(pres.statusCode, pres.headers);
      pres.pipe(res);
    });
    preq.on('error', () => {
      reviveHarness();
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'harness-offline', message: 'dsh 智能体服务未就绪' } }));
    });
    preq.end(rawJson);
    if (sid && payload) watchSessionFallback(sid, payload); // 观察该会话首次对话（协议 4xx → 自动降级重试）
    return;
  }

  // 转发到 dsh 智能体
  if (shouldProxy(req.url)) {
    return proxyHttp(req, res, resolveProxyPath(req.url));
  }

  // 静态文件
  serveStatic(urlPath, res, req);
});

// WebSocket 升级转发（/api/events.mux、/api/events.host 等）
server.on('upgrade', (req, socket, head) => {
  if (!shouldProxy(req.url)) { socket.destroy(); return; }
  proxyUpgrade(req, socket, head);
});

// ---------- 优雅关闭注册（信号/exit 兜底/异常日志/端口占用） ----------
// 关闭项目时组件同关：SIGINT/SIGTERM → shutdown() → 网关关闭 + 智能体子进程一并退出（不留孤儿）
process.on('SIGINT', () => shutdown('收到退出信号（SIGINT / Ctrl+C）', 0));
process.on('SIGTERM', () => shutdown('收到退出信号（SIGTERM）', 0));
// exit 钩子仅能同步：兜底保证智能体子进程不残留（正常退出与异常退出都覆盖）
process.on('exit', () => {
  if (harnessProcess && harnessProcess.exitCode === null && !harnessProcess.killed) {
    try { harnessProcess.kill(); } catch (e) { /* 已退出则忽略 */ }
  }
});
// 异常日志（不改变默认退出行为，仅防静默吞错、便于排查）
process.on('uncaughtException', (e) => console.error('[DSH Work Buddy] uncaughtException:', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('[DSH Work Buddy] unhandledRejection:', (e && e.stack) || e));
// 端口占用等 listen 错误：友好提示 + 退出（listen 失败时 ensureHarness 不会执行，无子进程需清理）
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`[DSH Work Buddy] 端口 ${PORT} 已被占用，请先关闭旧实例再启动（当前实例未启动成功）。`);
  } else {
    console.error('[DSH Work Buddy] HTTP 服务启动失败：', e && e.message);
  }
  shutdown('HTTP 服务启动失败', 1);
});
// 测试/运维钩子：文件信号触发优雅关闭。
// 不用 stdin 监听：stdin 的 'data' 监听会让其进入流动模式，与继承同一 stdin 的智能体子进程
// 产生读取竞争，导致 harness 启动卡死。DSH_WB_SHUTDOWN_FILE=<path>：文件出现即优雅关闭并消费信号。
const wbShutdownFile = process.env.DSH_WB_SHUTDOWN_FILE;
if (wbShutdownFile) {
  const wbShutdownTimer = setInterval(() => {
    try {
      if (fs.existsSync(wbShutdownFile)) {
        fs.unlinkSync(wbShutdownFile); // 消费信号
        shutdown('外部关闭信号（shutdown 文件）', 0);
      }
    } catch (e) { /* 忽略瞬时错误 */ }
  }, 500);
  wbShutdownTimer.unref();
}

// ---------- 启动 ----------
server.listen(PORT, HOST, () => {
  const urls = formatBindUrls();
  console.log(`DSH Work Buddy server listening on ${HOST}:${PORT}`);
  console.log(`  访问地址：${urls.join('\n              ')}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.log(`  提示：已允许同局域网跨设备访问；同网段设备可用上方 IPv4 地址访问，首次访问需放行 Windows 防火墙 8765 端口入站。`);
  }
  ensureHarness(); // 智能体组件：探测 → 未运行则自动拉起（127.0.0.1:3080）
  ensureWiki();    // Wiki 文档库：构建产物就位检查（/llm-wiki-plugin/）
  ensureSkills();  // dsh 技能：llm-wiki 项目技能安装到 .dsh/skills/（幂等）
  ensureUniversalPreset(); // 通用兼容模式 preset：安装到 harness 用户 preset 根（幂等）
});
