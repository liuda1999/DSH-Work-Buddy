@echo off
chcp 65001 >nul
title Stop DSH Work Buddy
setlocal EnableDelayedExpansion

REM ============================================================
REM DSH Work Buddy - stop
REM 2026-11-13: previously ran "taskkill /f /im node.exe" which
REM killed EVERY node process on the machine (e.g. unrelated
REM services). Now it only stops the DSH gateway process, which
REM takes its child agent process down with it.
REM ============================================================

set "DSH_WB_PORT=8765"

echo ========================================
echo   Stop DSH Work Buddy
echo ========================================
echo.

set "FOUND="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%DSH_WB_PORT%" ^| findstr LISTENING') do (
    set "FOUND=1"
    echo Stopping DSH gateway (PID %%P) on port %DSH_WB_PORT%...
    taskkill /f /pid %%P >nul 2>&1
)

if not defined FOUND (
    echo [INFO] Service not running on port %DSH_WB_PORT%
    echo.
    pause
    exit /b
)

timeout /t 2 /nobreak >nul

netstat -ano | findstr ":%DSH_WB_PORT%" | findstr LISTENING >nul
if errorlevel 1 (
    echo [OK] Service stopped
) else (
    echo [WARN] Port %DSH_WB_PORT% is still listening
)

echo.
REM Report whether other (unrelated) node services are still alive,
REM proving they were NOT touched by this script.
tasklist /fi "imagename eq node.exe" 2>nul | find "node.exe" >nul
if errorlevel 1 (
    echo [INFO] No other node processes running
) else (
    echo [INFO] Other node processes left untouched ^(by design^):
    tasklist /fi "imagename eq node.exe" 2>nul | findstr /i "node.exe"
)

echo.
pause
