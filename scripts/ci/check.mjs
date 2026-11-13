#!/usr/bin/env node
/**
 * DSH Work Buddy — CI 静态审计脚本
 *
 * 在 GitHub Actions 与本地均可运行（node scripts/ci/check.mjs）。
 * 覆盖七类检查：
 *   1. 必需文件存在性
 *   2. JS 语法（server.js / modules / deploy 工具）
 *   3. HTML 内联脚本语法（index.html / m.html）
 *   4. JSON 合法性 + 版本一致性（VERSION === package.json.version）
 *   5. 敏感信息扫描（GitHub PAT / 明文密码）
 *   6. 硬编码扫描（盘符绝对路径 / 内网 IP / 用户目录，仅限可执行代码行）
 *   7. 危险模式与回归指纹（taskkill /im 全杀、关键修复指纹在位）
 *
 * 任一 FAIL 退出码 1；全部 PASS 退出码 0。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CI_MODE = process.argv.includes('--ci');
const ROOT = process.cwd();

const results = [];
let section = '';
function check(name, ok, detail = '') {
  results.push({ name, ok });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`${tag}  [${section}] ${name}${ok ? '' : '  -> ' + String(detail).slice(0, 200)}`);
}
function sectionTitle(s) { section = s; console.log(`\n──── ${s} ────`); }

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/* ══ 1. 必需文件 ══ */
sectionTitle('1. 必需文件存在性');
const REQUIRED = [
  'VERSION', 'README.md', 'AGENTS.md', '.gitignore',
  'WorkBuddy-Web/server.js', 'WorkBuddy-Web/index.html', 'WorkBuddy-Web/m.html',
  'WorkBuddy-Web/package.json', 'WorkBuddy-Web/modules/datastore.js', 'WorkBuddy-Web/modules/navigation.js',
  'deploy/workbuddy-autostart.sh', 'deploy/dsh-workbuddy.service', 'deploy/install-service.sh',
  'deploy/repair-duplicate-tool-ids.mjs',
];
for (const f of REQUIRED) check('存在: ' + f, exists(f));

/* ══ 2. JS 语法 ══ */
sectionTitle('2. JS 语法（node --check）');
const jsFiles = ['WorkBuddy-Web/server.js',
  ...fs.readdirSync(path.join(ROOT, 'WorkBuddy-Web/modules')).filter((f) => f.endsWith('.js')).map((f) => 'WorkBuddy-Web/modules/' + f),
  ...fs.readdirSync(path.join(ROOT, 'deploy')).filter((f) => f.endsWith('.mjs')).map((f) => 'deploy/' + f)];
for (const f of jsFiles) {
  if (!exists(f)) { check('语法: ' + f, false, 'file missing'); continue; }
  const r = spawnSync('node', ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
  check('语法: ' + f, r.status === 0, r.stderr?.slice(0, 150));
}

/* ══ 3. HTML 内联脚本 ══ */
sectionTitle('3. HTML 内联脚本语法');
for (const html of ['WorkBuddy-Web/index.html', 'WorkBuddy-Web/m.html']) {
  if (!exists(html)) { check('内联脚本: ' + html, false, 'missing'); continue; }
  const t = read(html);
  const blocks = [...t.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let allOk = true;
  let firstErr = '';
  const tmp = path.join(os.tmpdir(), 'ci-inline-' + Math.random().toString(36).slice(2) + '.js');
  fs.writeFileSync(tmp, blocks.join('\n;\n'), 'utf8');
  const r = spawnSync('node', ['--check', tmp], { encoding: 'utf8' });
  allOk = r.status === 0;
  if (!allOk) firstErr = r.stderr?.slice(0, 200);
  try { fs.unlinkSync(tmp); } catch { /* cleanup best effort */ }
  check(`内联脚本语法: ${html} (${blocks.length} 块)`, allOk, firstErr);
}

/* ══ 4. JSON + 版本一致性 ══ */
sectionTitle('4. JSON 与版本一致性');
const version = read('VERSION').trim();
let pkgVersion = null;
try {
  const pkg = JSON.parse(read('WorkBuddy-Web/package.json'));
  pkgVersion = pkg.version;
  check('package.json 可解析', true);
} catch (e) { check('package.json 可解析', false, e.message); }
check('VERSION 与 package.json 一致', version === pkgVersion, `VERSION=${version} pkg=${pkgVersion}`);
check('VERSION 非占位（非 dev）', version !== 'dev' && /^\d+\.\d+\.\d+$/.test(version), version);

/* ══ 5. 敏感信息 ══ */
sectionTitle('5. 敏感信息扫描');
const SECRET_TARGETS = [
  'WorkBuddy-Web/server.js', 'WorkBuddy-Web/index.html', 'WorkBuddy-Web/m.html',
  'Start DSH Work Buddy.bat', 'Stop DSH Work Buddy.bat', '_autostart.bat', '_run_server.bat',
  'deploy/workbuddy-autostart.sh', 'deploy/dsh-workbuddy.service', 'deploy/install-service.sh',
  'deploy/repair-duplicate-tool-ids.mjs', 'README.md', 'AGENTS.md', '.gitignore',
];
const SECRET_RES = [
  { name: 'GitHub PAT', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'ghp token', re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: 'AWS key', re: /AKIA[0-9A-Z]{16}/ },
];
let secHits = [];
for (const rel of SECRET_TARGETS) {
  if (!exists(rel)) continue;
  const lines = read(rel).split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const p of SECRET_RES) {
      if (p.re.test(lines[i])) secHits.push(`${rel}:${i + 1} [${p.name}]`);
    }
  }
}
check('无 GitHub PAT / 云密钥泄露', secHits.length === 0, secHits.join('; '));

/* ══ 6. 硬编码扫描（可执行代码行）═══ */
sectionTitle('6. 硬编码扫描（可执行代码行）');
const HARD_TARGETS = [
  'WorkBuddy-Web/server.js', 'WorkBuddy-Web/index.html', 'WorkBuddy-Web/m.html',
  'Start DSH Work Buddy.bat', 'Stop DSH Work Buddy.bat', '_autostart.bat', '_run_server.bat',
];
const HARD_RES = [
  { name: '盘符项目路径 (D:\\DSH)', re: /D:\\DSH-Work-Buddy/ },
  { name: '内网 IP (192.168.x)', re: /192\.168\.\d+\.\d+/ },
  { name: '用户目录 (/home/liuda | C:\\Users\\NAS)', re: /\/home\/liuda|C:\\Users\\NAS/ },
];
const hardHits = [];
for (const rel of HARD_TARGETS) {
  if (!exists(rel)) continue;
  const lines = read(rel).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const isComment = /^(?:REM\s|rem\s|::|\/\/|\*)/.test(trimmed);
    if (isComment) continue;
    // index.html 的 placeholder 示例（用户输入提示）不算硬编码
    if (rel.endsWith('index.html') && line.includes('placeholder')) continue;
    for (const p of HARD_RES) {
      if (p.re.test(line)) hardHits.push(`${rel}:${i + 1} [${p.name}] ${trimmed.slice(0, 90)}`);
    }
  }
}
check('可执行代码无硬编码路径/IP', hardHits.length === 0, hardHits.join(' | '));

/* ══ 7. 危险模式与回归指纹 ══ */
sectionTitle('7. 危险模式与回归指纹');
// 7a. 任何 .bat 不得全杀 node
const batFiles = ['Start DSH Work Buddy.bat', 'Stop DSH Work Buddy.bat', '_autostart.bat', '_run_server.bat'];
for (const rel of batFiles) {
  if (!exists(rel)) continue;
  const execLines = read(rel).split('\n').filter((l) => !/^\s*(?:REM|rem|::)/.test(l));
  const bad = execLines.some((l) => /taskkill\s+\/f\s+\/im\s+node\.exe/i.test(l));
  check('无全杀 node 模式: ' + rel, !bad);
}
// 7b. Stop 脚本用 /pid 精确停止
check('Stop 脚本使用 /pid 精确停止', exists('Stop DSH Work Buddy.bat') && /taskkill\s+\/f\s+\/pid/.test(read('Stop DSH Work Buddy.bat')));
// 7c. 修复指纹（回归防护）
const fingerprints = [
  { f: 'WorkBuddy-Web/server.js', pat: 'function taskFileCopies', n: '任务副本同步' },
  { f: 'WorkBuddy-Web/server.js', pat: 'function findExistingTaskDir', n: '防目录复活' },
  { f: 'WorkBuddy-Web/server.js', pat: 'const byId = new Map()', n: '加载去重' },
  { f: 'WorkBuddy-Web/server.js', pat: 'MCP_PRESET_TARGET', n: 'MCP 单预设注入' },
  { f: 'WorkBuddy-Web/index.html', pat: 'detail-collapsed', n: '智能详情折叠' },
  { f: 'WorkBuddy-Web/index.html', pat: 'rel="icon"', n: 'favicon' },
  { f: 'WorkBuddy-Web/m.html', pat: 'd.content || []', n: '移动端用户消息渲染' },
  { f: 'Stop DSH Work Buddy.bat', pat: '/pid', n: '精确停止' },
  { f: '.gitignore', pat: '_quarantine-*/', n: 'gitignore 隔离覆盖' },
];
for (const fp of fingerprints) {
  if (!exists(fp.f)) { check('回归指纹: ' + fp.n, false, 'missing ' + fp.f); continue; }
  check('回归指纹: ' + fp.n, read(fp.f).includes(fp.pat), fp.pat);
}

/* ══ 汇总 ══ */
const failed = results.filter((r) => !r.ok);
console.log('\n════════════════════════════════');
console.log(`CI 审计: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length) {
  console.log('失败项:');
  for (const f of failed) console.log('  ✗ ' + f.name);
}
process.exit(failed.length > 0 ? 1 : 0);
