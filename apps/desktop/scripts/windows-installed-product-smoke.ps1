[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [ValidateSet("stable", "beta", "alpha")]
  [string]$PackageChannel = "stable",
  [string]$ProductName = $(if ($PackageChannel -eq "stable") { "ADE" } else { "ADE " + (Get-Culture).TextInfo.ToTitleCase($PackageChannel) }),
  [string]$CompanionInstallerPath = ""
)

$ErrorActionPreference = "Stop"
$installer = [IO.Path]::GetFullPath($InstallerPath)
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "Windows installed-product smoke is missing installer: $installer"
}
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw "LOCALAPPDATA is required for the per-user installed-product smoke."
}
if (-not [string]::IsNullOrWhiteSpace($CompanionInstallerPath) -and $PackageChannel -ne "stable") {
  throw "A companion installer may only be tested from the Stable lifecycle."
}

$installDir = Join-Path $env:LOCALAPPDATA "Programs\$ProductName"
$appExe = Join-Path $installDir "$ProductName.exe"
$uninstaller = Join-Path $installDir "Uninstall $ProductName.exe"
$cliName = if ($PackageChannel -eq "stable") { "ade.cmd" } else { "ade-$PackageChannel.cmd" }
$cliShim = Join-Path $env:LOCALAPPDATA "ADE\bin\$cliName"
$cliPathDir = Split-Path $cliShim -Parent
$runKey = "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run"
$uninstallRoot = "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall"

function Invoke-Installer {
  $process = Start-Process -FilePath $installer -ArgumentList @("/S") -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -ne 0) { throw "Installer exited with code $($process.ExitCode)." }
}

function Invoke-Uninstaller([bool]$BestEffort = $false) {
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    if ($BestEffort) { return }
    throw "Installed product is missing its uninstaller: $uninstaller"
  }
  try {
    $process = Start-Process -FilePath $uninstaller -ArgumentList @("/S") -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) { throw "Uninstaller exited with code $($process.ExitCode)." }
  } catch {
    if (-not $BestEffort) { throw }
    Write-Warning "Best-effort installed-product cleanup failed: $($_.Exception.Message)"
  }
}

function Stop-LaunchedApp {
  if ($launchedApp -and -not $launchedApp.HasExited) {
    & taskkill.exe /PID $launchedApp.Id /T /F | Out-Null
  }
  $script:launchedApp = $null
}

function Stop-InstalledProductProcesses {
  $normalizedAppExe = [IO.Path]::GetFullPath($appExe)
  $channelAdeHome = Join-Path ([Environment]::GetFolderPath("UserProfile")) $homeName
  $launcherPrefix = Join-Path $channelAdeHome "runtime\brain-service-"
  $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $supervisors = @($allProcesses | Where-Object {
    $_.Name -match '^powershell(?:\.exe)?$' -and
      ([string]$_.CommandLine).IndexOf($launcherPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  foreach ($supervisor in $supervisors) {
    & taskkill.exe /PID ([string]$supervisor.ProcessId) /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Could not stop channel-owned ADE supervisor $($supervisor.ProcessId) before repair."
    }
  }
  $processes = @($allProcesses | Where-Object {
    try {
      -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
        [string]::Equals(
          [IO.Path]::GetFullPath([string]$_.ExecutablePath),
          $normalizedAppExe,
          [StringComparison]::OrdinalIgnoreCase
        )
    } catch { $false }
  })
  foreach ($process in $processes) {
    & taskkill.exe /PID ([string]$process.ProcessId) /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
      $remaining = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ProcessId)" -ErrorAction SilentlyContinue
      if ($remaining) {
        throw "Could not stop channel-owned ADE process $($process.ProcessId) before repair."
      }
    }
  }
}

function Assert-InstalledProduct([string]$Phase) {
  foreach ($required in @(
    $appExe,
    $uninstaller,
    $cliShim,
    (Join-Path $installDir "resources\ade-cli\cli.cjs"),
    (Join-Path $installDir "resources\ade-cli\windows-install-setup.ps1"),
    (Join-Path $installDir "resources\ade-cli\windows-uninstall-cleanup.ps1")
  )) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "$Phase is missing installed product file: $required"
    }
  }
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $pathEntries = @($userPath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if (-not ($pathEntries | Where-Object {
    try { [IO.Path]::GetFullPath($_).TrimEnd("\") -eq [IO.Path]::GetFullPath($cliPathDir).TrimEnd("\") } catch { $false }
  })) {
    throw "$Phase did not add the ADE terminal directory to the user PATH."
  }
  $startupValues = if (Test-Path -LiteralPath $runKey) {
    (Get-Item -LiteralPath $runKey).GetValueNames() | Where-Object { $_ -like "ADE Runtime (*" }
  } else { @() }
  $ownedStartup = @($startupValues | Where-Object {
    [string](Get-Item -LiteralPath $runKey).GetValue($_) -like "*$homeName*brain-service-*.ps1*"
  })
  if ($ownedStartup.Count -ne 1) {
    throw "$Phase expected one channel-owned ADE startup entry, found $($ownedStartup.Count)."
  }
  $displayEntries = @(Get-ChildItem -LiteralPath $uninstallRoot -ErrorAction SilentlyContinue | ForEach-Object {
    Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
  } | Where-Object { $_.DisplayName -eq $ProductName })
  if ($displayEntries.Count -ne 1 -or $displayEntries[0].DisplayVersion -notmatch '^\d+\.\d+\.\d+') {
    throw "$Phase did not register exactly one installed $ProductName product with a version."
  }
  $mdAssociation = Get-Item -LiteralPath "Registry::HKEY_CURRENT_USER\Software\Classes\.md\OpenWithProgids" -ErrorAction SilentlyContinue
  $associationNames = if ($mdAssociation) { @($mdAssociation.GetValueNames()) } else { @() }
  if (-not ($associationNames | Where-Object { $_ -eq $fileClass })) {
    throw "$Phase did not register the .md file association."
  }
}

function Assert-UninstalledProduct {
  if (Test-Path -LiteralPath $appExe -PathType Leaf) { throw "Uninstall left the ADE executable behind." }
  if (Test-Path -LiteralPath $cliShim -PathType Leaf) { throw "Uninstall left its owned ADE terminal shim behind." }

  $remainingShims = @(Get-ChildItem -LiteralPath $cliPathDir -Filter "ade*.cmd" -File -ErrorAction SilentlyContinue)
  $remainingPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $pathStillRegistered = [bool](@($remainingPath -split ";") | Where-Object {
    try { [IO.Path]::GetFullPath($_).TrimEnd("\") -eq [IO.Path]::GetFullPath($cliPathDir).TrimEnd("\") } catch { $false }
  })
  if ($remainingShims.Count -gt 0 -and -not $pathStillRegistered) {
    throw "Uninstall removed the shared ADE terminal PATH entry while another channel shim remains."
  }
  if ($remainingShims.Count -eq 0 -and $pathStillRegistered) {
    throw "Uninstall left an unowned ADE terminal PATH entry behind."
  }

  $remainingStartup = if (Test-Path -LiteralPath $runKey) {
    @((Get-Item -LiteralPath $runKey).GetValueNames() | Where-Object {
      [string](Get-Item -LiteralPath $runKey).GetValue($_) -like "*$homeName*brain-service-*.ps1*"
    })
  } else { @() }
  if ($remainingStartup.Count -ne 0) { throw "Uninstall left its ADE brain startup entry behind." }
  if ($PackageChannel -eq "stable" -and (Test-Path -LiteralPath "Registry::HKEY_CURRENT_USER\Software\Classes\ade")) {
    throw "Uninstall left its owned ade:// protocol registration behind."
  }
  $remainingMdAssociation = Get-Item -LiteralPath "Registry::HKEY_CURRENT_USER\Software\Classes\.md\OpenWithProgids" -ErrorAction SilentlyContinue
  if ($remainingMdAssociation -and @($remainingMdAssociation.GetValueNames()) -contains $fileClass) {
    throw "Uninstall left its owned .md file association behind."
  }
}

$homeName = if ($PackageChannel -eq "stable") { ".ade" } else { ".ade-$PackageChannel" }
$fileClass = if ($PackageChannel -eq "stable") { "com.ade.desktop.files" } else { "com.ade.desktop.$PackageChannel.files" }
$launchedApp = $null
$uninstallVerified = $false
try {
  Invoke-Installer
  Assert-InstalledProduct "fresh install"

  Remove-Item -LiteralPath $cliShim -Force
  Invoke-Installer
  Assert-InstalledProduct "repair reinstall"

  Stop-InstalledProductProcesses
  Remove-Item -LiteralPath $appExe -Force
  Invoke-Installer
  Assert-InstalledProduct "missing-executable repair"

  Invoke-Installer
  Assert-InstalledProduct "idempotent reinstall"

  if ($PackageChannel -eq "stable") {
    $launchedApp = Start-Process -FilePath $appExe -ArgumentList @("ade://work") -PassThru
    $protocolCommand = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ([DateTime]::UtcNow -lt $deadline) {
      try {
        $protocolCommand = [string](Get-Item -LiteralPath "Registry::HKEY_CURRENT_USER\Software\Classes\ade\shell\open\command" -ErrorAction Stop).GetValue("")
      } catch {}
      if ($protocolCommand -like "*$appExe*") { break }
      Start-Sleep -Milliseconds 250
    }
    if ($protocolCommand -notlike "*$appExe*") {
      throw "Installed Stable ADE did not claim the ade:// deep-link protocol."
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($CompanionInstallerPath)) {
    $companion = [IO.Path]::GetFullPath($CompanionInstallerPath)
    if (-not (Test-Path -LiteralPath $companion -PathType Leaf)) {
      throw "Windows side-by-side smoke is missing the Beta installer: $companion"
    }
    & $PSCommandPath -InstallerPath $companion -PackageChannel beta -ProductName "ADE Beta"
    Assert-InstalledProduct "Stable after Beta side-by-side lifecycle"
    $mdDefault = [string](Get-Item -LiteralPath "Registry::HKEY_CURRENT_USER\Software\Classes\.md" -ErrorAction Stop).GetValue("")
    if ($mdDefault -ne $fileClass) {
      throw "Beta uninstall did not restore Stable as the .md default association."
    }
  }

  Stop-LaunchedApp
  Invoke-Uninstaller
  Assert-UninstalledProduct
  $uninstallVerified = $true
} finally {
  Stop-LaunchedApp
  if (-not $uninstallVerified) {
    Invoke-Uninstaller -BestEffort $true
  }
}

$sideBySideResult = if ([string]::IsNullOrWhiteSpace($CompanionInstallerPath)) { "" } else { ", Stable/Beta side-by-side ownership" }
Write-Output "Windows installed-product smoke passed: install, repair, reinstall, PATH, startup, deep links, file association$sideBySideResult, uninstall."
