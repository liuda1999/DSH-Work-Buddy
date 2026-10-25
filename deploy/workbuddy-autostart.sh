#!/bin/bash
# WorkBuddy-Web 开机自启包装脚本（版本受控：worke/deploy/）
# 由 deploy/install-service.sh 安装到 systemd 引用；APP 路径从脚本自身位置推导，
# 项目目录迁移/改名无需改动本脚本。版本信息不写入本文件（由 GitHub Releases 承载）。
set -u

# APP = 本脚本所在目录的上一级 / WorkBuddy-Web（即 <repo>/WorkBuddy-Web）
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)/WorkBuddy-Web"

if [ ! -f "$APP/server.js" ]; then
  echo "[workbuddy] 未找到 server.js：$APP" >&2
  exit 1
fi

cd "$APP" || exit 1
exec node server.js
