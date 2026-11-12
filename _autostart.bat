@echo off
REM DSH Work Buddy autostart (scheduled task entry)
REM 2026-11-13: paths now derive from this script's own location (%~dp0)
REM instead of a hardcoded drive path; node resolved from PATH with a
REM fallback to the default install dir; logs redirected + rotated.
setlocal

set "ROOT=%~dp0"
set "APPDIR=%ROOT%WorkBuddy-Web"
set "DSH_WB_HOST=0.0.0.0"
set "DSH_WB_PORT=8765"

cd /d "%APPDIR%" || exit /b 1

set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 (
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
    ) else (
        echo [DSH Work Buddy] Node.js not found 1>&2
        exit /b 1
    )
)

REM rotate logs when they exceed 10MB to avoid unbounded growth
if exist "_run-out.log" for %%F in ("_run-out.log") do if %%~zF GTR 10485760 move /y "_run-out.log" "_run-out.log.1" >nul 2>&1
if exist "_run-err.log" for %%F in ("_run-err.log") do if %%~zF GTR 10485760 move /y "_run-err.log" "_run-err.log.1" >nul 2>&1

"%NODE_EXE%" server.js >> "_run-out.log" 2>> "_run-err.log"
