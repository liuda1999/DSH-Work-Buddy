@echo off
REM DSH Work Buddy - manual foreground run (debug helper)
REM 2026-11-13: removed hardcoded user profile path; node resolved from PATH.
setlocal

set "ROOT=%~dp0"
set "APPDIR=%ROOT%WorkBuddy-Web"
set "DSH_WB_HOST=0.0.0.0"
set "DSH_WB_PORT=8765"

REM Prepend the user-level npm global bin (pnpm/corepack shims live there)
if defined APPDATA set "PATH=%APPDATA%\npm;%PATH%"

cd /d "%APPDIR%" || exit /b 1
node server.js
