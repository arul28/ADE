@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "CLI_JS=%ADE_CLI_JS%"
if "%CLI_JS%"=="" set "CLI_JS=%SCRIPT_DIR%..\cli.cjs"

set "RESOURCES_DIR=%SCRIPT_DIR%..\.."
set "APP_EXE=%RESOURCES_DIR%\..\ADE.exe"
set "NODE_PATH_VALUE=%RESOURCES_DIR%\app.asar.unpacked\node_modules;%RESOURCES_DIR%\app.asar\node_modules"
if defined NODE_PATH (
  if defined NODE_PATH_VALUE (
    set "NODE_PATH_VALUE=%NODE_PATH_VALUE%;%NODE_PATH%"
  ) else (
    set "NODE_PATH_VALUE=%NODE_PATH%"
  )
)

if defined ADE_CLI_NODE (
  call :run_with_runtime_env "%ADE_CLI_NODE%" "%CLI_JS%" %*
  exit /b %ERRORLEVEL%
)

if exist "%APP_EXE%" (
  set "ELECTRON_RUN_AS_NODE=1"
  call :run_with_runtime_env "%APP_EXE%" "%CLI_JS%" %*
  exit /b %ERRORLEVEL%
)

where node >nul 2>nul
if not errorlevel 1 (
  node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>nul
  if not errorlevel 1 (
    call :run_with_runtime_env node "%CLI_JS%" %*
    exit /b %ERRORLEVEL%
  )
)

echo ade: Node.js 22+ or the packaged ADE.exe runtime is required to run this CLI. 1>&2
exit /b 127

:run_with_runtime_env
if defined NODE_PATH_VALUE set "NODE_PATH=%NODE_PATH_VALUE%"
%*
exit /b %ERRORLEVEL%
