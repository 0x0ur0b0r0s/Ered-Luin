@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pnpm-node24.ps1" %*
exit /b %ERRORLEVEL%
