'use strict';

/**
 * 数据存储工具：版本化信封 + 原子写入（临时文件替换）+ 旧格式自动迁移 + 路径防穿越。
 * 用于 WorkBuddy-Web 本地业务数据（插件社区收藏 / 归档组清单 / 智能体模板清单等）的持久化，
 * 避免直接写数组导致半写入损坏、缺少版本信息的问题。
 * 注意：任务数据（data/tasks/<id>/task.json）仍保持原有直接落盘方式，未迁移到本模块。
 */

const fs = require('fs');
const path = require('path');

const CURRENT_VERSION = 1;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function envelope(data, version = CURRENT_VERSION) {
  return { version, updatedAt: new Date().toISOString(), data };
}

// 原子写入：先写临时文件 → 原文件备份 .bak → 再 rename 替换，避免半写入损坏
function atomicWriteJson(file, data, options = {}) {
  const target = path.resolve(file);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const backup = `${target}.bak`;
  const text = JSON.stringify(data, null, 2) + '\n';
  try {
    fs.writeFileSync(temp, text, 'utf8');
    if (fs.existsSync(target) && options.backup !== false) {
      try { fs.copyFileSync(target, backup); } catch (_) { /* best effort backup */ }
    }
    fs.renameSync(temp, target);
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) { /* cleanup is best effort */ }
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

// 旧格式迁移：裸数组/对象 → 版本信封；v0 → CURRENT_VERSION 逐级迁移
function migrateValue(raw, initial, migrations = {}) {
  if (raw == null) return { value: clone(initial), version: CURRENT_VERSION, changed: true };
  let value = raw && Object.prototype.hasOwnProperty.call(raw, 'data') ? raw.data : raw;
  let version = Number(raw && raw.version) || 0;
  while (version < CURRENT_VERSION) {
    const migrate = migrations[version];
    if (typeof migrate === 'function') value = migrate(value);
    version += 1;
  }
  return { value, version, changed: version !== Number(raw && raw.version) || !raw || !Object.prototype.hasOwnProperty.call(raw, 'data') };
}

/**
 * 打开 JSON 存储。
 * @param {string} file  存储文件路径
 * @param {object} options
 *   - initial: 文件不存在时的初始数据（默认 {}）
 *   - migrations: 版本迁移函数表
 *   - allowCreate: 文件不存在时是否立即建文件并落盘（默认 true；设 false 则缺失时仅内存返回 initial，
 *                  不产生空文件——用于「全新安装不落盘、seed 注入」的场景，见 loadAgentTemplates）
 */
function openJsonStore(file, options = {}) {
  const initial = options.initial === undefined ? {} : options.initial;
  const existsBefore = fs.existsSync(file);
  const migrated = migrateValue(readJson(file), initial, options.migrations);
  const store = {
    file: path.resolve(file),
    version: CURRENT_VERSION,
    data: migrated.value,
    // 文件此前是否已存在（区分「缺失」与「存在但为空」，供调用方决定 seed 兜底）
    exists: existsBefore,
    save() {
      atomicWriteJson(this.file, envelope(this.data));
      this.exists = true;
      return clone(this.data);
    },
    replace(next) {
      this.data = next;
      this.save();
      return clone(this.data);
    }
  };
  if (migrated.changed && (existsBefore || options.allowCreate !== false)) store.save();
  return store;
}

// 路径防穿越：candidate 必须位于 root 之下（或等于 root），否则返回 null
function resolveInside(root, candidate) {
  const base = path.resolve(root);
  const full = path.resolve(base, String(candidate || ''));
  return full === base || full.startsWith(base + path.sep) ? full : null;
}

module.exports = { CURRENT_VERSION, atomicWriteJson, openJsonStore, resolveInside, envelope };
