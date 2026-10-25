#!/bin/bash
# DSH Work Buddy systemd 服务安装/更新器（幂等）。
# 用法：sudo bash install-service.sh [--restart]
#   1. 从本脚本位置推导仓库路径（部署目录 = <repo>/deploy）
#   2. 以实际路径填充 unit 模板并写入 /etc/systemd/system/dsh-workbuddy.service
#   3. systemctl daemon-reload；--restart 时同时重启服务
# 修改服务定义请编辑本目录的 dsh-workbuddy.service 模板后重跑本脚本（纳入 git 管控）。
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"
UNIT_SRC="$DEPLOY_DIR/dsh-workbuddy.service"
UNIT_DST="/etc/systemd/system/dsh-workbuddy.service"
WRAPPER="$DEPLOY_DIR/workbuddy-autostart.sh"

[ -f "$REPO_DIR/WorkBuddy-Web/server.js" ] || { echo "[install] 未找到 $REPO_DIR/WorkBuddy-Web/server.js" >&2; exit 1; }
[ -f "$UNIT_SRC" ] || { echo "[install] 未找到模板 $UNIT_SRC" >&2; exit 1; }
[ -x "$WRAPPER" ] || chmod +x "$WRAPPER" 2>/dev/null || true

if [ "$(id -u)" -ne 0 ]; then
  echo "[install] 需要 root（sudo）。用法：sudo bash $0 [--restart]" >&2
  exit 1
fi

sed -e "s|@REPO_DIR@|$REPO_DIR|g" -e "s|@DEPLOY_DIR@|$DEPLOY_DIR|g" "$UNIT_SRC" > "$UNIT_DST"
chmod 644 "$UNIT_DST"
systemctl daemon-reload
echo "[install] 已写入 $UNIT_DST（repo=$REPO_DIR deploy=$DEPLOY_DIR）"

if [ "${1:-}" = "--restart" ]; then
  systemctl restart dsh-workbuddy.service
  echo "[install] 服务已重启"
fi
systemctl --no-pager cat dsh-workbuddy.service | sed -n '1,12p'
