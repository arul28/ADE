@echo off
setlocal
rem cmd.exe ends a command at its first line feed, so a multi-line --prompt
rem or --text is cut here. The CLI reads this marker to warn about it.
set "ADE_CLI_VIA_CMD=1"

set "SCRIPT_DIR=%~dp0"
set "CLI_JS=%ADE_CLI_JS%"
if "%CLI_JS%"=="" set "CLI_JS=%SCRIPT_DIR%..\cli.cjs"

set "RESOURCES_DIR=%SCRIPT_DIR%..\.."
set "APP_EXE_NAME=ADE.exe"
set "CHANNEL_FILE=%SCRIPT_DIR%..\channel"
if exist "%CHANNEL_FILE%" (
  set /p ADE_BUNDLED_CHANNEL=<"%CHANNEL_FILE%"
)
if /I "%ADE_BUNDLED_CHANNEL%"=="beta" (
  set "APP_EXE_NAME=ADE Beta.exe"
  if not defined ADE_PACKAGE_CHANNEL set "ADE_PACKAGE_CHANNEL=beta"
  if not defined ADE_DESKTOP_APP_NAME set "ADE_DESKTOP_APP_NAME=ADE Beta"
  rem The channel's own home, as the packaged app sets it. Without this the
  rem channel CLI resolved the stable home and its pipe, so `brain status` and
  rem `brain stop` could not reach the running beta brain.
  if not defined ADE_HOME set "ADE_HOME=%USERPROFILE%\.ade-beta"
)
if /I "%ADE_BUNDLED_CHANNEL%"=="alpha" (
  set "APP_EXE_NAME=ADE Alpha.exe"
  if not defined ADE_PACKAGE_CHANNEL set "ADE_PACKAGE_CHANNEL=alpha"
  if not defined ADE_DESKTOP_APP_NAME set "ADE_DESKTOP_APP_NAME=ADE Alpha"
  rem The channel's own home, as the packaged app sets it. Without this the
  rem channel CLI resolved the stable home and its pipe, so `brain status` and
  rem `brain stop` could not reach the running alpha brain.
  if not defined ADE_HOME set "ADE_HOME=%USERPROFILE%\.ade-alpha"
)
rem Node's compile cache stops the ~19 MB cli.cjs bundle from being re-parsed on every
rem launch. Node ignores a cache directory it cannot use. An explicit
rem NODE_COMPILE_CACHE or NODE_DISABLE_COMPILE_CACHE from the caller wins.
if not defined NODE_COMPILE_CACHE if not defined NODE_DISABLE_COMPILE_CACHE if defined ADE_HOME set "NODE_COMPILE_CACHE=%ADE_HOME%\cache\node-compile"
if not defined NODE_COMPILE_CACHE if not defined NODE_DISABLE_COMPILE_CACHE set "NODE_COMPILE_CACHE=%USERPROFILE%\.ade\cache\node-compile"
set "APP_EXE=%RESOURCES_DIR%\..\%APP_EXE_NAME%"
if not defined ADE_AGENT_SKILLS_DIRS if exist "%RESOURCES_DIR%\agent-skills" set "ADE_AGENT_SKILLS_DIRS=%RESOURCES_DIR%\agent-skills"
set "NODE_PATH_VALUE=%RESOURCES_DIR%\app.asar.unpacked\node_modules;%RESOURCES_DIR%\app.asar\node_modules"
if defined NODE_PATH (
  if defined NODE_PATH_VALUE (
    set "NODE_PATH_VALUE=%NODE_PATH_VALUE%;%NODE_PATH%"
  ) else (
    set "NODE_PATH_VALUE=%NODE_PATH%"
  )
)

rem Every branch below runs the CLI through :run. `exit /b %ERRORLEVEL%` inside
rem a parenthesized block is expanded when the block is parsed, before the CLI
rem runs, so it always returned 0 and a failed command looked like a success.
if defined ADE_CLI_NODE (
  set "ADE_RUN_EXE=%ADE_CLI_NODE%"
  goto :run
)

if exist "%APP_EXE%" (
  set "ELECTRON_RUN_AS_NODE=1"
  set "ADE_RUN_EXE=%APP_EXE%"
  goto :run
)

where node >nul 2>nul
if not errorlevel 1 (
  node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>nul
  if not errorlevel 1 (
    set "ADE_RUN_EXE=node"
    goto :run
  )
)

echo ade: Node.js 22+ or the packaged ADE.exe runtime is required to run this CLI. 1>&2
exit /b 127

:run
if defined NODE_PATH_VALUE set "NODE_PATH=%NODE_PATH_VALUE%"
"%ADE_RUN_EXE%" "%CLI_JS%" %*
exit /b %ERRORLEVEL%
