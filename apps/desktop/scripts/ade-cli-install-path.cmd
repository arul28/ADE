@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "ADE_BIN=%ADE_BIN%"
if "%ADE_BIN%"=="" set "ADE_BIN=%SCRIPT_DIR%bin\ade.cmd"

set "TARGET_PATH=%~1"
if "%TARGET_PATH%"=="" (
  if defined LOCALAPPDATA (
    set "TARGET_PATH=%LOCALAPPDATA%\ADE\bin\ade.cmd"
  ) else (
    set "TARGET_PATH=%USERPROFILE%\.ade\bin\ade.cmd"
  )
)

if not exist "%ADE_BIN%" (
  echo ade install: missing bundled CLI wrapper at %ADE_BIN% 1>&2
  exit /b 1
)

for %%I in ("%TARGET_PATH%") do set "TARGET_DIR=%%~dpI"
if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%" >nul 2>nul

(
  echo @echo off
  echo "%ADE_BIN%" %%*
) > "%TARGET_PATH%"

if errorlevel 1 (
  echo ade install: failed to write %TARGET_PATH% 1>&2
  exit /b 1
)

echo Installed ade -^> %ADE_BIN%
echo Ensure %TARGET_DIR% is on PATH, then run: ade doctor
