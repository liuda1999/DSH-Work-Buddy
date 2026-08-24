#!/usr/bin/env bash
# DSH Work Buddy 一键启动（macOS / Linux）
# 与 start.bat 行为等价：依赖安装/构建（幂等）→ 端口检查 → 启动 Web + 拉起智能体
# 首次运行前：chmod +x start.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HARNESS="$ROOT/deepseek-harness/deepseek-harness-master"
WIKI="$ROOT/llm-wiki/project"

echo "=========================================="
echo "  DSH Work Buddy 一键启动  (v0.1.7)"
echo "   固定端口: http://127.0.0.1:8765"
echo "=========================================="
echo

# ---- 0/5 检查 Node.js（harness 要求 ^22.19 || >=24）----
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 Node.js，请先安装 Node.js 22.19 或 24 及以上（https://nodejs.org）"
  exit 1
fi
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "[错误] Node.js 版本过低（当前 $(node -v)），请升级到 ^22.19 或 >=24"
  exit 1
fi

# ---- 1/5 检测 pnpm（corepack / npx 兜底）----
PNPM_CMD="pnpm"
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    echo "[提示] 未检测到 pnpm，尝试 corepack ..."
    corepack enable >/dev/null 2>&1 || true
    if ! command -v pnpm >/dev/null 2>&1; then
      echo "[提示] corepack 安装失败，将改用 npx pnpm@11.7.0"
      PNPM_CMD="npx pnpm@11.7.0"
    fi
  else
    echo "[提示] corepack 也不可用，将改用 npx pnpm@11.7.0"
    PNPM_CMD="npx pnpm@11.7.0"
  fi
fi

# ---- 2/5 智能体依赖安装 + 构建（幂等）----
if [ ! -d "$HARNESS/node_modules" ]; then
  echo "[1/5] 安装智能体依赖（$PNPM_CMD install），首次较慢..."
  (cd "$HARNESS" && $PNPM_CMD install)
else
  echo "[1/5] 智能体依赖已存在，跳过安装"
fi
if [ ! -d "$HARNESS/apps/web/dist" ]; then
  echo "[2/5] 构建智能体产物（$PNPM_CMD run build），首次较慢..."
  (cd "$HARNESS" && $PNPM_CMD run build)
else
  echo "[2/5] 智能体构建产物已存在，跳过构建"
fi

# ---- 3/5 Wiki 文档库依赖安装 + 构建（VitePress，产物由网关托管在 /llm-wiki-plugin/）----
WIKI_PNPM="$PNPM_CMD"
if [ "$WIKI_PNPM" = "npx pnpm@11.7.0" ]; then WIKI_PNPM="npx pnpm@10.33.0"; fi
if [ ! -d "$WIKI/node_modules" ]; then
  echo "[3/5] 安装 Wiki 文档库依赖（$WIKI_PNPM install），首次较慢..."
  (cd "$WIKI" && $WIKI_PNPM install)
else
  echo "[3/5] Wiki 文档库依赖已存在，跳过安装"
fi
if [ ! -d "$WIKI/docs/.vitepress/dist" ]; then
  echo "[3/5] 构建 Wiki 文档库站点（$WIKI_PNPM run docs:build）..."
  (cd "$WIKI" && $WIKI_PNPM run docs:build)
else
  echo "[3/5] Wiki 文档库构建产物已存在，跳过构建"
fi

# ---- 4/5 端口检查 ----
if lsof -i :8765 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[错误] 端口 8765 已被占用，请先关闭旧实例再运行本脚本"
  exit 1
fi

# ---- 5/5 启动 Web（server.js 会自动拉起 dsh 智能体服务，并托管 Wiki 文档库）----
echo "[4/5] 启动 Web 控制台并拉起智能体..."
if command -v open >/dev/null 2>&1; then
  (open "http://127.0.0.1:8765" >/dev/null 2>&1 || true) &
elif command -v xdg-open >/dev/null 2>&1; then
  (xdg-open "http://127.0.0.1:8765" >/dev/null 2>&1 || true) &
fi
(cd "$ROOT/WorkBuddy-Web" && node server.js)

echo "[5/5] Web 服务已退出"
