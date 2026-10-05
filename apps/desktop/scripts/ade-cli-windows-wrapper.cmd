@echo off
setlocal

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

rem Interactive full-screen commands cannot run under the bundled Electron on
rem Windows. Measured inside a real ConPTY: `node` reports stdin.isTTY=true and
rem a working setRawMode, directly and through cmd.exe; the same Electron binary
rem with ELECTRON_RUN_AS_NODE=1 reports isTTY=false and no setRawMode at all.
rem Ink needs raw mode, so `ade code` died with a raw-mode stack trace. The .cmd
rem shim chain is NOT the cause - real node keeps its TTY through cmd.exe.
rem macOS is unaffected: Electron-as-node keeps the TTY there, which is why the
rem same command works on a Mac.
set "ADE_NEEDS_TTY="
if /I "%~1"=="code" set "ADE_NEEDS_TTY=1"
if defined ADE_NEEDS_TTY (
  where node >nul 2>nul
  if not errorlevel 1 (
    node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>nul
    if not errorlevel 1 (
      set "ADE_RUN_EXE=node"
      goto :run
    )
  )
  rem Reaching here means no Node 22+ was found. The bundled Electron cannot
  rem stand in for it: ELECTRON_RUN_AS_NODE gives no TTY on Windows, so the TUI
  rem cannot start under it at all. The CLI's runtime dependencies are unpacked
  rem from app.asar precisely so a plain node can load them (see asarUnpack in
  rem apps/desktop/package.json) - without that unpack this branch would fail
  rem with "Cannot find module '@linear/sdk'" instead.
  echo ade: '%~1' needs an interactive terminal, which the bundled ADE runtime cannot provide on Windows. 1>&2
  echo Install Node.js 22 or newer and run this command again, or set ADE_CLI_NODE to a Node 22+ executable. 1>&2
  exit /b 127
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
