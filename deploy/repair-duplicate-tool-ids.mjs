#!/usr/bin/env node
/**
 * 会话日志修复工具：消除 assistant 消息内重复的 tool-call id。
 *
 * 背景：本地 llama.cpp 的 openai-responses 协议偶发为并行工具调用分配相同 item_id，
 * harness 拼成 `call_X|fc_X` 落盘；DeepSeek 官方 API 严格校验 tool_call_id 唯一性会 400。
 * 协议侧已由把 qwen 路由切到 openai-completions 根治；本工具修复**已落盘**的污染会话。
 *
 * 关键：harness 的 session.jsonl.zstd 是「逐事件多帧流」——第一帧必须恰好是一行（会话头），
 * 之后每个事件各占一帧。因此本工具按行重压为独立帧并拼接，绝不可整体压成一帧。
 *
 * 用法：node repair-duplicate-tool-ids.mjs <session.jsonl.zstd> [--dry]
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';

const file = process.argv[2];
const dry = process.argv.includes('--dry');
if (!file || !existsSync(file)) {
  console.error('用法: node repair-duplicate-tool-ids.mjs <session.jsonl.zstd> [--dry]');
  process.exit(2);
}

const dir = dirname(file);
const raw = execFileSync('zstd', ['-dc', file], { maxBuffer: 1024 * 1024 * 512 }).toString('utf8');
const lines = raw.split('\n').filter((l) => l.trim().length > 0);
const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });

let changed = 0;
const renamed = new Map();
const pending = new Map();

for (const ev of events) {
  if (!ev) continue;
  if (ev.type === 'assistant/message') {
    const content = (ev.data && ev.data.message && ev.data.message.content) || [];
    const seen = new Set();
    for (const block of content) {
      if (!block || block.type !== 'tool-call') continue;
      const id = block.id;
      if (seen.has(id)) {
        const n = (pending.get(id) || []).length + 2;
        const newId = `${id}-dup${n}`;
        pending.set(id, [...(pending.get(id) || []), newId]);
        block.id = newId;
        changed += 1;
        renamed.set(id, [...(renamed.get(id) || []), newId]);
      } else {
        seen.add(id);
      }
    }
    continue;
  }
  if (ev.type === 'tool/result') {
    const msg = ev.data && ev.data.message;
    if (!msg || !msg.source) continue;
    const callId = msg.source.callId;
    const queue = pending.get(callId);
    if (queue && queue.length) {
      const newId = queue.shift();
      msg.source.callId = newId;
      for (const block of msg.content || []) {
        if (block && block.type === 'tool-result' && block.toolCallId === callId) block.toolCallId = newId;
      }
      changed += 1;
    }
  }
}

console.log(`扫描 ${events.length} 个事件；需改写点：${changed}`);
if (renamed.size) for (const [from, to] of renamed) console.log(`  ${from} → ${to.join(', ')}`);
if (dry) { console.log('（--dry：未写回）'); process.exit(0); }
if (!changed) { console.log('无需修复'); process.exit(0); }

const backup = `${file}.bak-${Date.now()}`;
copyFileSync(file, backup);
console.log('已备份 →', backup);

// 按行重压为独立帧（保持 harness 的逐事件多帧格式），逐行拼接
const outPath = join(dir, '.repair-out.zst');
const linePath = join(dir, '.repair-line.txt');
try {
  if (existsSync(outPath)) unlinkSync(outPath);
  const chunks = [];
  for (const ev of events) {
    if (!ev) continue;
    writeFileSync(linePath, JSON.stringify(ev) + '\n', 'utf8');
    chunks.push(execFileSync('zstd', ['-q', '-c', linePath], { maxBuffer: 64 * 1024 * 1024 }));
  }
  writeFileSync(outPath, Buffer.concat(chunks));
  copyFileSync(outPath, file);
  console.log(`已写回（${chunks.length} 帧，逐事件格式）`);
} finally {
  for (const p of [outPath, linePath]) { try { if (existsSync(p)) unlinkSync(p); } catch { /* 清理失败忽略 */ } }
}
