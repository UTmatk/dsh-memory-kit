@echo off
REM DSH memory tool wrapper. Usage: mem ingest / status / inbox / pending / render / sync / search KW / show ID
setlocal
chcp 65001 >nul 2>&1
set "NODE=%~dp0dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0memory\bin\memctl.mjs" %*
