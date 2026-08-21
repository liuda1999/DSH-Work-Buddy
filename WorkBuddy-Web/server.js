// DSH Work Buddy 一体化服务：固定端口 8765，随启动自动拉起 dsh 智能体（127.0.0.1:3080），
// 并提供 /harness/ 同源代理、RPC 转发、WebSocket 桥接、本地业务 mock 与静态文件服务。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 8765;
const HARNESS_HOST = '127.0.0.1';
const HARNESS_PORT = 3080;
const HARNESS_DIR = path.resolve(__dirname, '..', 'deepseek-harness', 'deepseek-harness-master');
const HARNESS_START_CMD = ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web'];
const HARNESS_READY_TIMEOUT_MS = 60000;
const HARNESS_PROBE_INTERVAL_MS = 2000;
const HARNESS_PROBE_TIMEOUT_MS = 1500;

let harnessProcess = null;
let harnessUp = false;

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
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('Not found: ' + p); return; }
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
    console.log(`[DSH Work Buddy] 检测到 dsh 智能体服务已在 http://${HARNESS_HOST}:${HARNESS_PORT} 运行，跳过拉起。`);
    return;
  }
  if (!fs.existsSync(HARNESS_DIR)) {
    console.error(`[DSH Work Buddy] 未找到 dsh 智能体目录：${HARNESS_DIR}，智能体服务无法自动启动。`);
    return;
  }
  console.log(`[DSH Work Buddy] 启动 dsh 智能体服务（${HARNESS_DIR}）...`);
  harnessProcess = spawn('node', HARNESS_START_CMD, {
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
      console.log(`[DSH Work Buddy] dsh 智能体服务就绪：http://${HARNESS_HOST}:${HARNESS_PORT}`);
      return;
    }
    if (Date.now() > deadline) {
      console.warn(`[DSH Work Buddy] 等待 dsh 智能体服务超时（${HARNESS_READY_TIMEOUT_MS / 1000}s），请检查其日志。`);
      return;
    }
    setTimeout(poll, HARNESS_PROBE_INTERVAL_MS);
  };
  poll();
}

// ---------- 代理转发（HTTP + WebSocket） ----------
// 本地业务 mock 前缀（不转发）
const LOCAL_API_PREFIXES = [
  '/api/workspaces', '/api/tasks', '/api/archive', '/api/wiki',
  '/api/resources', '/api/schedule', '/api/search', '/api/plugin-community'
];
const isLocalApi = (p) => p === '/api/workspaces/sync-harness' || LOCAL_API_PREFIXES.some((pre) => p === pre || p.startsWith(pre + '/'));

// WorkBuddy 自身的静态资源（不转发）
const WORKBUDDY_STATIC = (p) =>
  p === '/' || p === '/index.html' ||
  p === '/logo.jpg' || p === '/favicon.ico' || p === '/favicon.png' ||
  p.startsWith('/card-bg/');

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
  const proxyReq = http.request({
    host: HARNESS_HOST, port: HARNESS_PORT, path: targetPath, method: req.method, headers
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ ok: false, error: { code: 'harness-offline', message: 'dsh 智能体服务未就绪' } }));
  });
  req.pipe(proxyReq);
}

function proxyUpgrade(req, socket, head) {
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

// ---------- 本地业务 mock 数据 ----------
const db = {
  workspaces: [],
  tasks: [],
  archiveGroups: [],
  wikiDocs: [],
  plugins: [],
  skills: [],
  agentTemplates: [],
  pluginCommunity: []
};

function nextId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function seedData() {
  db.workspaces = [
    { id: 'ws_default', name: '默认工作区' }
  ];
  const now = new Date().toISOString();
  db.tasks = [
    { id: nextId('t'), title: '完成项目总览设计', status: 'in_progress', workspaceId: 'ws_default', deadline: null, createdAt: now, completedAt: null },
    { id: nextId('t'), title: '整理 Wiki 文档', status: 'today', workspaceId: 'ws_default', deadline: now, createdAt: now, completedAt: null },
    { id: nextId('t'), title: '集成智能体组件', status: 'completed', workspaceId: 'ws_default', deadline: null, createdAt: now, completedAt: now },
    { id: nextId('t'), title: '修复逾期任务提醒', status: 'overdue', workspaceId: 'ws_default', deadline: '2024-01-01T00:00:00Z', createdAt: now, completedAt: null }
  ];
}
seedData();

function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// 内部调用 dsh 智能体 RPC（envelope 格式）
function harnessRpc(method, payload = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'wb-srv-' + Math.random().toString(36).slice(2), method, payload });
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
    req.on('error', reject);
    req.end(body);
  });
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

async function handleLocalApi(req, res, urlPath, params) {
  // 智能体同步探测
  if (urlPath === '/api/workspaces/sync-harness' && req.method === 'POST') {
    harnessUp = await probeHarness();
    return sendJson(res, 200, { harnessUp, registered: [], removed: [] });
  }

  if (urlPath === '/api/workspaces' && req.method === 'GET') {
    return sendJson(res, 200, { workspaces: db.workspaces });
  }
  if (urlPath === '/api/workspaces' && req.method === 'POST') {
    const body = await readBody(req);
    const ws = { id: nextId('ws'), name: body.name || '未命名工作区' };
    db.workspaces.push(ws);
    return sendJson(res, 200, ws);
  }
  if (urlPath.startsWith('/api/workspaces/') && urlPath.endsWith('/files') && req.method === 'GET') {
    return sendJson(res, 200, { files: [] });
  }
  if (urlPath.startsWith('/api/workspaces/') && req.method === 'DELETE') {
    const id = urlPath.split('/').pop();
    db.workspaces = db.workspaces.filter((w) => w.id !== id);
    db.tasks = db.tasks.filter((t) => t.workspaceId !== id);
    return sendJson(res, 200, { success: true });
  }

  if (urlPath === '/api/tasks' && req.method === 'GET') {
    const ws = params.ws;
    let tasks = db.tasks;
    if (ws && ws !== 'all') tasks = tasks.filter((t) => t.workspaceId === ws);
    return sendJson(res, 200, { tasks });
  }
  if (urlPath === '/api/tasks' && req.method === 'POST') {
    const body = await readBody(req);
    const task = {
      id: nextId('t'),
      title: body.title || '新任务',
      status: body.status || 'today',
      workspaceId: body.workspaceId || (db.workspaces[0] && db.workspaces[0].id) || null,
      deadline: body.deadline || null,
      createdAt: new Date().toISOString(),
      completedAt: null
    };
    db.tasks.push(task);
    return sendJson(res, 200, task);
  }
  if (urlPath.startsWith('/api/tasks/') && req.method === 'PATCH') {
    const id = urlPath.split('/')[3];
    const body = await readBody(req);
    const task = db.tasks.find((t) => t.id === id);
    if (task) {
      Object.assign(task, body);
      if (body.status === 'completed' && !task.completedAt) task.completedAt = new Date().toISOString();
      if (body.status && body.status !== 'completed') task.completedAt = null;
    }
    return sendJson(res, 200, task || {});
  }
  if (urlPath.startsWith('/api/tasks/') && req.method === 'DELETE') {
    const id = urlPath.split('/')[3];
    db.tasks = db.tasks.filter((t) => t.id !== id);
    return sendJson(res, 200, { success: true });
  }
  if (urlPath.match(/^\/api\/tasks\/[^/]+\/files$/) && req.method === 'GET') {
    return sendJson(res, 200, { files: [] });
  }
  if (urlPath.match(/^\/api\/tasks\/[^/]+\/tree$/) && req.method === 'GET') {
    return sendJson(res, 200, { tree: [] });
  }
  if (urlPath.match(/^\/api\/tasks\/[^/]+\/docs$/) && req.method === 'GET') {
    return sendJson(res, 200, { docs: [] });
  }
  if (urlPath.match(/^\/api\/tasks\/[^/]+\/docs$/) && req.method === 'POST') {
    return sendJson(res, 200, { success: true });
  }

  if (urlPath === '/api/archive/groups' && req.method === 'GET') {
    return sendJson(res, 200, { groups: db.archiveGroups });
  }
  if (urlPath === '/api/archive/groups' && req.method === 'POST') {
    const body = await readBody(req);
    const group = { id: nextId('ag'), name: body.name || '归档组' };
    db.archiveGroups.push(group);
    return sendJson(res, 200, group);
  }
  if (urlPath === '/api/archive/sessions' && req.method === 'GET') {
    return sendJson(res, 200, { sessions: [] });
  }
  if (urlPath === '/api/archive/detail' && req.method === 'GET') {
    return sendJson(res, 200, { detail: null });
  }

  if (urlPath === '/api/wiki/docs' && req.method === 'GET') {
    return sendJson(res, 200, { docs: db.wikiDocs });
  }
  if (urlPath === '/api/wiki/search' && req.method === 'GET') {
    return sendJson(res, 200, { results: [] });
  }
  if (urlPath === '/api/wiki/doc' && req.method === 'GET') {
    return sendJson(res, 200, { doc: null });
  }
  if (urlPath === '/api/wiki/doc' && req.method === 'POST') {
    const body = await readBody(req);
    const doc = { path: body.path || 'doc.md', content: body.content || '' };
    db.wikiDocs.push(doc);
    return sendJson(res, 200, doc);
  }
  if (urlPath === '/api/wiki/doc' && req.method === 'DELETE') {
    return sendJson(res, 200, { success: true });
  }
  if (urlPath === '/api/wiki/repos' && req.method === 'GET') {
    return sendJson(res, 200, { repos: [] });
  }
  if (urlPath === '/api/wiki/graph' && req.method === 'POST') {
    return sendJson(res, 200, { success: true });
  }
  if (urlPath === '/api/wiki/graph-query' && req.method === 'POST') {
    return sendJson(res, 200, { results: [] });
  }
  if (urlPath === '/api/wiki/inject-agent-docs' && req.method === 'POST') {
    return sendJson(res, 200, { success: true });
  }

  // 插件 Tab：对接 dsh 智能体预设（agentPreset.list），作为智能体自带插件展示
  if (urlPath === '/api/resources/plugins' && req.method === 'GET') {
    try {
      const v = await harnessRpc('agentPreset.list', {});
      const plugins = (v.presets || []).map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description || '',
        enabled: true,
        preset: p.id,
        isDefault: !!p.isDefault
      }));
      return sendJson(res, 200, { plugins, source: 'harness' });
    } catch (e) {
      return sendJson(res, 200, { plugins: [], source: 'unavailable' });
    }
  }
  if (urlPath === '/api/resources/plugins/toggle' && req.method === 'POST') {
    return sendJson(res, 200, { success: true });
  }
  if (urlPath === '/api/resources/skills' && req.method === 'GET') {
    return sendJson(res, 200, { skills: db.skills });
  }
  if (urlPath === '/api/resources/skills/toggle' && req.method === 'POST') {
    return sendJson(res, 200, { success: true });
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
    return sendJson(res, 200, tpl);
  }
  if (urlPath.match(/^\/api\/resources\/agent-templates\/[^/]+$/) && req.method === 'PUT') {
    const id = urlPath.split('/').pop();
    const body = await readBody(req);
    const tpl = db.agentTemplates.find((t) => t.id === id);
    if (tpl) Object.assign(tpl, body);
    return sendJson(res, 200, tpl || {});
  }
  if (urlPath.match(/^\/api\/resources\/agent-templates\/[^/]+$/) && req.method === 'DELETE') {
    const id = urlPath.split('/').pop();
    db.agentTemplates = db.agentTemplates.filter((t) => t.id !== id);
    return sendJson(res, 200, { success: true });
  }

  if (urlPath === '/api/schedule' && req.method === 'GET') {
    return sendJson(res, 200, { events: [] });
  }
  if (urlPath === '/api/search' && req.method === 'GET') {
    return sendJson(res, 200, { results: [] });
  }
  if (urlPath === '/api/plugin-community' && req.method === 'GET') {
    return sendJson(res, 200, { items: db.pluginCommunity });
  }
  if (urlPath === '/api/plugin-community' && req.method === 'POST') {
    const body = await readBody(req);
    const item = { id: nextId('pc'), ...body };
    db.pluginCommunity.push(item);
    return sendJson(res, 200, item);
  }
  if (urlPath.startsWith('/api/plugin-community/') && req.method === 'DELETE') {
    const id = urlPath.split('/').pop();
    db.pluginCommunity = db.pluginCommunity.filter((p) => p.id !== id);
    return sendJson(res, 200, { success: true });
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

// ---------- 启动 ----------
server.listen(PORT, HOST, () => {
  console.log(`DSH Work Buddy server running at http://${HOST}:${PORT}`);
  ensureHarness();
});
