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
    set "ADE_USER_HOME=%USERPROFILE%"
    if "%ADE_USER_HOME%"=="" set "ADE_USER_HOME=%HOMEDRIVE%%HOMEPATH%"
    if "%ADE_USER_HOME%"=="" set "ADE_USER_HOME=%CD%"
    set "TARGET_PATH=%ADE_USER_HOME%\AppData\Local\ADE\bin\ade.cmd"
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
  echo exit /b %%ERRORLEVEL%%
) > "%TARGET_PATH%"

if errorlevel 1 (
  echo ade install: failed to write %TARGET_PATH% 1>&2
  exit /b 1
)

if not "%ADE_SKIP_USER_PATH_UPDATE%"=="1" (
  call :ensure_user_path "%TARGET_DIR%"
  if errorlevel 1 exit /b %ERRORLEVEL%
)

echo Installed ade -^> %ADE_BIN%
if "%ADE_SKIP_USER_PATH_UPDATE%"=="1" (
  echo Ensure %TARGET_DIR% is on PATH, then run: ade doctor
) else (
  echo Added %TARGET_DIR% to the user PATH if it was missing.
  echo Open a new terminal, then run: ade doctor
)
exit /b 0

:ensure_user_path
set "PATH_DIR=%~1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$target=[System.IO.Path]::GetFullPath($args[0]).TrimEnd('\'); $current=[Environment]::GetEnvironmentVariable('Path','User'); $entries=if ([string]::IsNullOrWhiteSpace($current)) { @() } else { $current -split ';' | Where-Object { $_.Trim().Length -gt 0 } }; foreach ($entry in $entries) { try { if ([System.IO.Path]::GetFullPath($entry).TrimEnd('\').ToLowerInvariant() -eq $target.ToLowerInvariant()) { exit 0 } } catch {} }; $next=if ([string]::IsNullOrWhiteSpace($current)) { $target } else { $target + ';' + $current }; [Environment]::SetEnvironmentVariable('Path',$next,'User')" "%PATH_DIR%" >nul 2>nul
if errorlevel 1 (
  echo ade install: failed to update the user PATH. Add %PATH_DIR% manually. 1>&2
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand JABzAGkAZwBuAGEAdAB1AHIAZQAgAD0AIABAACcACgB1AHMAaQBuAGcAIABTAHkAcwB0AGUAbQA7AAoAdQBzAGkAbgBnACAAUwB5AHMAdABlAG0ALgBSAHUAbgB0AGkAbQBlAC4ASQBuAHQAZQByAG8AcABTAGUAcgB2AGkAYwBlAHMAOwAKAHAAdQBiAGwAaQBjACAAcwB0AGEAdABpAGMAIABjAGwAYQBzAHMAIABOAGEAdABpAHYAZQBNAGUAdABoAG8AZABzACAAewAKACAAIABbAEQAbABsAEkAbQBwAG8AcgB0ACgAIgB1AHMAZQByADMAMgAuAGQAbABsACIALAAgAFMAZQB0AEwAYQBzAHQARQByAHIAbwByAD0AdAByAHUAZQAsACAAQwBoAGEAcgBTAGUAdAA9AEMAaABhAHIAUwBlAHQALgBBAHUAdABvACkAXQAKACAAIABwAHUAYgBsAGkAYwAgAHMAdABhAHQAaQBjACAAZQB4AHQAZQByAG4AIABJAG4AdABQAHQAcgAgAFMAZQBuAGQATQBlAHMAcwBhAGcAZQBUAGkAbQBlAG8AdQB0ACgASQBuAHQAUAB0AHIAIABoAFcAbgBkACwAIAB1AGkAbgB0ACAATQBzAGcALAAgAFUASQBuAHQAUAB0AHIAIAB3AFAAYQByAGEAbQAsACAAcwB0AHIAaQBuAGcAIABsAFAAYQByAGEAbQAsACAAdQBpAG4AdAAgAGYAdQBGAGwAYQBnAHMALAAgAHUAaQBuAHQAIAB1AFQAaQBtAGUAbwB1AHQALAAgAG8AdQB0ACAAVQBJAG4AdABQAHQAcgAgAGwAcABkAHcAUgBlAHMAdQBsAHQAKQA7AAoAfQAKACcAQAAKAEEAZABkAC0AVAB5AHAAZQAgAC0AVAB5AHAAZQBEAGUAZgBpAG4AaQB0AGkAbwBuACAAJABzAGkAZwBuAGEAdAB1AHIAZQAKACQAcgBlAHMAdQBsAHQAIAA9ACAAWwBVAEkAbgB0AFAAdAByAF0AOgA6AFoAZQByAG8ACgBbAE4AYQB0AGkAdgBlAE0AZQB0AGgAbwBkAHMAXQA6ADoAUwBlAG4AZABNAGUAcwBzAGEAZwBlAFQAaQBtAGUAbwB1AHQAKABbAEkAbgB0AFAAdAByAF0AMAB4AGYAZgBmAGYALAAwAHgAMQBBACwAWwBVAEkAbgB0AFAAdAByAF0AOgA6AFoAZQByAG8ALAAnAEUAbgB2AGkAcgBvAG4AbQBlAG4AdAAnACwAMgAsADUAMAAwADAALABbAHIAZQBmAF0AJAByAGUAcwB1AGwAdAApACAAfAAgAE8AdQB0AC0ATgB1AGwAbAA= >nul 2>nul
exit /b 0
