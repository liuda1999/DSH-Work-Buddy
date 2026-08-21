@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

set "ROOT=%~dp0"
set "HARNESS=%ROOT%deepseek-harness\deepseek-harness-master"

echo ==========================================
echo   DSH Work Buddy 一键启动  (v0.1.0)
echo   固定端口: http://127.0.0.1:8765
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js ^22.19 或 ^>=24
  pause
  exit /b 1
)

rem ---- 检测 pnpm（corepack 安装到用户目录 / npx 兜底）----
set "PNPM_CMD=pnpm"
set "PNPM_DIR=%LOCALAPPDATA%\pnpm"
where pnpm >nul 2>nul
if errorlevel 1 (
  echo [提示] 未检测到 pnpm，尝试通过 corepack 安装到用户目录...
  where corepack >nul 2>nul
  if errorlevel 1 (
    echo [提示] corepack 也不可用，将改用 npx pnpm@11.7.0
    set "PNPM_CMD=npx pnpm@11.7.0"
  ) else (
    call corepack enable --install-directory "%PNPM_DIR%" >nul 2>nul
    set "PATH=%PNPM_DIR%;%PATH%"
    where pnpm >nul 2>nul
    if errorlevel 1 (
      echo [提示] corepack 安装失败，将改用 npx pnpm@11.7.0
      set "PNPM_CMD=npx pnpm@11.7.0"
    )
  )
)

rem ---- 1/4 依赖安装 ----
if not exist "%HARNESS%\node_modules" (
  echo [1/4] 安装智能体依赖（%PNPM_CMD% install），首次较慢...
  pushd "%HARNESS%"
  %PNPM_CMD% install
  if errorlevel 1 (
    echo [错误] 智能体依赖安装失败，请检查网络与 pnpm 配置
    popd
    pause
    exit /b 1
  )
  popd
) else (
  echo [1/4] 智能体依赖已存在，跳过安装
)

rem ---- 2/4 智能体构建 ----
if not exist "%HARNESS%\apps\web\dist" (
  echo [2/4] 构建智能体产物（pnpm run build），首次较慢...
  pushd "%HARNESS%"
  %PNPM_CMD% run build
  if errorlevel 1 (
    echo [错误] 智能体构建失败，请检查构建日志
    popd
    pause
    exit /b 1
  )
  popd
) else (
  echo [2/4] 智能体构建产物已存在，跳过构建
)

rem ---- 3/4 端口检查 ----
netstat -ano | findstr ":8765" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo [错误] 端口 8765 已被占用，请先关闭旧实例再运行本脚本
  pause
  exit /b 1
)

rem ---- 4/4 启动 Web（server.js 会自动拉起 dsh 智能体服务）----
echo [3/4] 启动 Web 控制台并拉起智能体...
start "" "http://127.0.0.1:8765"
pushd "%ROOT%WorkBuddy-Web"
node server.js
popd

echo [4/4] Web 服务已退出
pause
