@echo off
chcp 65001 >nul
title DSH Work Buddy
setlocal EnableDelayedExpansion

REM ============================================================
REM DSH Work Buddy - start
REM 2026-11-13: removed hardcoded drive path / node path / LAN IP.
REM All paths derive from this script location (%~dp0) so the
REM package works after being unzipped anywhere, on any machine.
REM ============================================================

set "ROOT=%~dp0"
set "APPDIR=%ROOT%WorkBuddy-Web"
set "DSH_WB_HOST=0.0.0.0"
set "DSH_WB_PORT=8765"

echo ========================================
echo   DSH Work Buddy
echo   Starting service...
echo ========================================
echo.

if not exist "%APPDIR%\server.js" (
    echo [ERROR] server.js not found in %APPDIR%
    pause
    exit /b 1
)

REM Preferred: node on PATH. Falls back to the default install location.
set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 (
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
    ) else (
        echo [ERROR] Node.js not found. Install Node.js 22.19 or ^>=24.
        pause
        exit /b 1
    )
)

REM Already running?
netstat -ano | findstr ":%DSH_WB_PORT%" | findstr LISTENING >nul
if %errorlevel%==0 (
    echo [INFO] Service already running on port %DSH_WB_PORT%
    echo Opening http://127.0.0.1:%DSH_WB_PORT%
    start "" "http://127.0.0.1:%DSH_WB_PORT%"
    goto :eof
)

echo [1/2] Starting server...
cd /d "%APPDIR%"
start "DSH Work Buddy Server" /MIN cmd /c ""%NODE_EXE%" server.js"

echo [2/2] Waiting for startup...
timeout /t 10 /nobreak >nul

netstat -ano | findstr ":%DSH_WB_PORT%" | findstr LISTENING >nul
if %errorlevel%==0 (
    echo.
    echo [OK] Service started successfully!
    echo.
    REM LAN address is detected at runtime instead of being hardcoded.
    echo   Local:  http://127.0.0.1:%DSH_WB_PORT%
    for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /c:"IPv4"') do (
        for /f "tokens=1" %%B in ("%%A") do echo   LAN:    http://%%B:%DSH_WB_PORT%
    )
    echo.
    echo Opening browser...
    start "" "http://127.0.0.1:%DSH_WB_PORT%"
) else (
    echo.
    echo [FAIL] Service failed to start
    echo Check the "DSH Work Buddy Server" console window for details.
)

echo.
timeout /t 3 /nobreak >nul
