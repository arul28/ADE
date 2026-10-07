# The window a Windows update shows between "ADE quit" and "the new ADE is on
# screen".
#
# A Windows update is silent (`quitAndInstall(true, true)`; see
# autoUpdateService.ts for why it has to be), so without this nothing is on
# screen for the whole install. People reopened ADE mid-install, and the
# installer force-killed every ADE.exe under the install folder, which looked
# like a crash on launch.
#
# The desktop app copies this file out of the install folder before it quits
# and starts it with powershell.exe. Both matter: the installer renames the
# install folder away and kills every process whose image lives inside it, and
# powershell.exe lives in System32.
#
# Settings come from progress-args.json beside this file, not the command line.
# The app has to start this through `cmd /c start` (a detached powershell.exe
# exits within half a second without running anything, measured in Windows
# Sandbox), and keeping user paths off that command line means cmd never parses
# a path that holds `&` or `%`.
#
# What it watches, every half second:
#   - the old app's process (ParentPid)           -> "Closing ADE"
#   - the installer's process (InstallerPath)      -> "Installing"
#   - install-steps.log lines written after start  -> the named setup step
#   - a new ADE.exe from AppExe with a window      -> done, close
# When the installer is gone and no new ADE appears, it says so and offers to
# open ADE, instead of leaving the person with nothing.
#
# The window is topmost. It starts from a background process, and Windows does
# not let a background process take the foreground, so a normal window opened
# behind whatever was on screen and nobody saw it.
#
# It also publishes a heartbeat file. A copy of ADE launched by hand during the
# install reads it, asks this window to come forward, and exits instead of
# starting up only to be killed by the installer.
[CmdletBinding()]
param(
  [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $PSScriptRoot "progress-args.json"
}
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
function Read-ConfigString([string]$Name, [string]$Default = "") {
  $value = $config.$Name
  if ($null -eq $value) { return $Default }
  return [string]$value
}
$TargetVersion = Read-ConfigString "targetVersion"
$AppExe = Read-ConfigString "appExe"
$HeartbeatPath = Read-ConfigString "heartbeatPath"
$ProductName = Read-ConfigString "productName" "ADE"
$CurrentVersion = Read-ConfigString "currentVersion"
$InstallerPath = Read-ConfigString "installerPath"
$StepsLogPath = Read-ConfigString "stepsLogPath"
$ParentPid = [int](Read-ConfigString "parentPid" "0")
$LogPath = Read-ConfigString "logPath"
$TimeoutSeconds = [int](Read-ConfigString "timeoutSeconds" "600")
if ([string]::IsNullOrWhiteSpace($TargetVersion) -or [string]::IsNullOrWhiteSpace($AppExe) -or [string]::IsNullOrWhiteSpace($HeartbeatPath)) {
  throw "progress-args.json needs targetVersion, appExe and heartbeatPath."
}
$startedAt = Get-Date
$ellipsis = [char]0x2026

function Write-ProgressLog([string]$Event, [string]$Detail = "") {
  if ([string]::IsNullOrWhiteSpace($LogPath)) { return }
  try {
    $elapsed = ((Get-Date) - $startedAt).TotalSeconds
    $line = "{0} +{1:N1}s {2} {3}" -f ([DateTime]::UtcNow.ToString("o")), $elapsed, $Event, $Detail
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  } catch {
    # Diagnostics only.
  }
}

function Test-ProcessAlive([int]$ProcessId) {
  if ($ProcessId -le 0) { return $false }
  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Get-ProcessesAtPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return @() }
  $name = [IO.Path]::GetFileNameWithoutExtension($Path)
  return @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object {
    try { [string]::Equals($_.Path, $Path, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
  })
}

function Get-InstalledVersion {
  try {
    $info = (Get-Item -LiteralPath $AppExe -ErrorAction Stop).VersionInfo
    $version = [string]$info.ProductVersion
    if ([string]::IsNullOrWhiteSpace($version)) { $version = [string]$info.FileVersion }
    # NSIS stamps four parts (1.2.95.0); the app speaks three.
    return ($version -replace '^(\d+\.\d+\.\d+)\.0$', '$1')
  } catch {
    return ""
  }
}

# Each line in install-steps.log names a step that just FINISHED, so the step
# shown is the one that comes after the newest finished step.
$stepAfter = @{
  "service_removal"     = "Installing $ProductName $TargetVersion$ellipsis"
  "service_status_read" = "Setting up the ade command$ellipsis"
  "path_shim_install"   = "Opening $ProductName$ellipsis"
  "brain_start"         = "Opening $ProductName$ellipsis"
}
$stepsLogOffset = 0L
if (-not [string]::IsNullOrWhiteSpace($StepsLogPath) -and (Test-Path -LiteralPath $StepsLogPath -PathType Leaf)) {
  $stepsLogOffset = (Get-Item -LiteralPath $StepsLogPath).Length
}
$lastFinishedStep = ""

function Update-LastFinishedStep {
  if ([string]::IsNullOrWhiteSpace($StepsLogPath)) { return }
  if (-not (Test-Path -LiteralPath $StepsLogPath -PathType Leaf)) { return }
  try {
    $stream = [IO.File]::Open($StepsLogPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
      if ($stream.Length -lt $script:stepsLogOffset) { $script:stepsLogOffset = 0L }
      if ($stream.Length -eq $script:stepsLogOffset) { return }
      [void]$stream.Seek($script:stepsLogOffset, [IO.SeekOrigin]::Begin)
      $reader = New-Object IO.StreamReader($stream)
      $text = $reader.ReadToEnd()
      $script:stepsLogOffset = $stream.Length
    } finally {
      $stream.Dispose()
    }
    foreach ($line in ($text -split "`r?`n")) {
      $parts = $line.Trim() -split '\s+'
      if ($parts.Count -ge 3 -and $stepAfter.ContainsKey($parts[2])) {
        $script:lastFinishedStep = $parts[2]
        Write-ProgressLog "step_finished" $line.Trim()
      }
    }
  } catch {
    # The installer may hold the file for a moment; the next tick reads it.
  }
}

function Write-Heartbeat([string]$Phase) {
  try {
    $payload = @{
      pid = $PID
      targetVersion = $TargetVersion
      appExe = $AppExe
      phase = $Phase
      updatedAt = [DateTime]::UtcNow.ToString("o")
    } | ConvertTo-Json -Compress
    $tmp = "$HeartbeatPath.$PID.tmp"
    [IO.File]::WriteAllText($tmp, $payload)
    Move-Item -LiteralPath $tmp -Destination $HeartbeatPath -Force
  } catch {
    # A missed beat only means a hand-launched ADE may start normally.
  }
}

function Remove-Heartbeat {
  try {
    $current = Get-Content -LiteralPath $HeartbeatPath -Raw -ErrorAction Stop | ConvertFrom-Json
    if ([int]$current.pid -eq $PID) { Remove-Item -LiteralPath $HeartbeatPath -Force -ErrorAction SilentlyContinue }
  } catch {
    # Already gone.
  }
  Remove-Item -LiteralPath "$HeartbeatPath.focus" -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath "$HeartbeatPath.cancel" -Force -ErrorAction SilentlyContinue
}

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Drawing

# Read the icon now: the installer moves AppExe away in a few seconds.
$iconSource = $null
try {
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($AppExe)
  if ($icon) {
    $iconSource = [System.Windows.Interop.Imaging]::CreateBitmapSourceFromHIcon(
      $icon.Handle,
      [System.Windows.Int32Rect]::Empty,
      [System.Windows.Media.Imaging.BitmapSizeOptions]::FromEmptyOptions())
  }
} catch {
  Write-ProgressLog "icon_unavailable" $_.Exception.Message
}

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Updating $ProductName"
        Width="440" SizeToContent="Height"
        WindowStartupLocation="CenterScreen"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ResizeMode="NoResize" ShowInTaskbar="True" ShowActivated="True" Topmost="True">
  <Border CornerRadius="14" Background="#FF17131F" BorderBrush="#33FFFFFF" BorderThickness="1" Padding="26,22,26,22">
    <Border.Effect>
      <DropShadowEffect BlurRadius="24" ShadowDepth="0" Opacity="0.45" Color="#FF000000"/>
    </Border.Effect>
    <StackPanel>
      <DockPanel LastChildFill="True">
        <Image x:Name="AppIcon" Width="36" Height="36" Margin="0,0,14,0" DockPanel.Dock="Left" VerticalAlignment="Center"/>
        <StackPanel VerticalAlignment="Center">
          <TextBlock x:Name="Headline" Foreground="#FFF4F1FA" FontFamily="Segoe UI Variable Display, Segoe UI" FontSize="17" FontWeight="SemiBold"/>
          <TextBlock x:Name="Subline" Foreground="#FFA79FBD" FontFamily="Segoe UI" FontSize="12.5" Margin="0,3,0,0" TextWrapping="Wrap"/>
        </StackPanel>
      </DockPanel>
      <Grid x:Name="ProgressRow" Margin="0,20,0,0" Height="4">
        <Border CornerRadius="2" Background="#22FFFFFF"/>
        <Border x:Name="Track" CornerRadius="2" ClipToBounds="True">
          <Border x:Name="Sweep" CornerRadius="2" Width="120" HorizontalAlignment="Left">
            <Border.Background>
              <LinearGradientBrush StartPoint="0,0" EndPoint="1,0">
                <GradientStop Color="#008B5CF6" Offset="0"/>
                <GradientStop Color="#FFA78BFA" Offset="0.5"/>
                <GradientStop Color="#008B5CF6" Offset="1"/>
              </LinearGradientBrush>
            </Border.Background>
            <Border.RenderTransform>
              <TranslateTransform x:Name="SweepShift" X="-120"/>
            </Border.RenderTransform>
          </Border>
        </Border>
      </Grid>
      <DockPanel Margin="0,12,0,0" LastChildFill="False">
        <TextBlock x:Name="Elapsed" DockPanel.Dock="Left" Foreground="#FF7C7393" FontFamily="Segoe UI" FontSize="11.5"/>
        <StackPanel x:Name="Actions" DockPanel.Dock="Right" Orientation="Horizontal" Visibility="Collapsed">
          <Button x:Name="CloseButton" Content="Close" Margin="0,0,8,0" Padding="14,5" Foreground="#FFD9D3E6" Background="#22FFFFFF" BorderThickness="0" Cursor="Hand"/>
          <Button x:Name="OpenButton" Content="Open $ProductName" Padding="14,5" Foreground="#FFFFFFFF" Background="#FF7C3AED" BorderThickness="0" Cursor="Hand"/>
        </StackPanel>
      </DockPanel>
    </StackPanel>
  </Border>
</Window>
"@

$window = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$headline = $window.FindName("Headline")
$subline = $window.FindName("Subline")
$elapsedText = $window.FindName("Elapsed")
$actions = $window.FindName("Actions")
$sweepShift = $window.FindName("SweepShift")
if ($iconSource) {
  $window.FindName("AppIcon").Source = $iconSource
  $window.Icon = $iconSource
}
$window.Add_MouseLeftButtonDown({ try { $window.DragMove() } catch {} })

$headline.Text = "Updating $ProductName to $TargetVersion"
$subline.Text = "Closing $ProductName$ellipsis"

$sweep = New-Object System.Windows.Media.Animation.DoubleAnimation
$sweep.From = -120
$sweep.To = 440
$sweep.Duration = New-Object System.Windows.Duration ([TimeSpan]::FromSeconds(1.4))
$sweep.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
$sweepShift.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, $sweep)

$state = @{
  phase = "closing"
  installerSeen = $false
  installerGoneAt = $null
  parentGoneAt = $null
  done = $false
}

# PowerShell variable names ignore case, so these parameters must not be named
# like the $headline / $subline controls they fill.
function Show-Failure([string]$FailureTitle, [string]$FailureDetail) {
  if ($state.phase -eq "failed") { return }
  $state.phase = "failed"
  $sweepShift.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, $null)
  $window.FindName("ProgressRow").Visibility = "Collapsed"
  $headline.Text = $FailureTitle
  $subline.Text = $FailureDetail
  $elapsedText.Text = ""
  $actions.Visibility = "Visible"
  $window.Activate() | Out-Null
  Write-Heartbeat "failed"
  Write-ProgressLog "failed" "$FailureTitle | $FailureDetail"
}

$window.FindName("CloseButton").Add_Click({ $window.Close() })
$window.FindName("OpenButton").Add_Click({
  try {
    Start-Process -FilePath $AppExe | Out-Null
    Write-ProgressLog "open_clicked"
  } catch {
    Write-ProgressLog "open_failed" $_.Exception.Message
  }
  $window.Close()
})

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({
  try {
    $now = Get-Date
    $seconds = [int]($now - $startedAt).TotalSeconds
    if ($state.phase -ne "failed") {
      $elapsedText.Text = "{0}s" -f $seconds
    }

    if (Test-Path -LiteralPath "$HeartbeatPath.focus") {
      Remove-Item -LiteralPath "$HeartbeatPath.focus" -Force -ErrorAction SilentlyContinue
      Write-ProgressLog "focus_requested"
      if ($window.WindowState -eq "Minimized") { $window.WindowState = "Normal" }
      $window.Activate() | Out-Null
    }

    if ($state.phase -eq "failed") { return }

    # ADE unwound the install and is staying open: nothing to show.
    if (Test-Path -LiteralPath "$HeartbeatPath.cancel") {
      Write-ProgressLog "cancelled"
      $window.Close()
      return
    }

    # Done: a new ADE from the install folder has a window on screen.
    $newApps = @(Get-ProcessesAtPath $AppExe | Where-Object {
      try { $_.StartTime -gt $startedAt -and $_.Id -ne $ParentPid } catch { $false }
    })
    if ($newApps.Count -gt 0) {
      if ($state.phase -ne "opening") {
        $state.phase = "opening"
        $subline.Text = "Opening $ProductName$ellipsis"
        Write-ProgressLog "app_started" ("pid=" + (($newApps | ForEach-Object { $_.Id }) -join ","))
      }
      $windowed = @($newApps | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })
      if ($windowed.Count -gt 0) {
        $installed = Get-InstalledVersion
        Write-ProgressLog "app_window_shown" "version=$installed"
        if (-not [string]::IsNullOrWhiteSpace($installed) -and $installed -ne $TargetVersion) {
          # The app came back, but on the old version. It shows its own
          # "did not install" notice, so this window only gets out of the way.
          Write-ProgressLog "came_back_on_other_version" "installed=$installed target=$TargetVersion"
        }
        $state.done = $true
        $window.Close()
        return
      }
      Write-Heartbeat "opening"
      return
    }

    $parentAlive = Test-ProcessAlive $ParentPid
    if (-not $parentAlive -and -not $state.parentGoneAt) {
      $state.parentGoneAt = $now
      Write-ProgressLog "parent_exited"
    }

    $installerAlive = (Get-ProcessesAtPath $InstallerPath).Count -gt 0
    if ($installerAlive -and -not $state.installerSeen) {
      $state.installerSeen = $true
      Write-ProgressLog "installer_seen"
    }
    if ($state.installerSeen -and -not $installerAlive -and -not $state.installerGoneAt) {
      $state.installerGoneAt = $now
      Write-ProgressLog "installer_exited"
    }

    Update-LastFinishedStep

    # ADE never quit and no installer ever ran: the install unwound before a
    # cancel could be written. Leave quietly rather than say "Closing" forever.
    if ($parentAlive -and -not $state.installerSeen -and ($now - $startedAt).TotalSeconds -ge 45) {
      Write-ProgressLog "parent_never_quit"
      $window.Close()
      return
    }

    if ($parentAlive) {
      $state.phase = "closing"
      $subline.Text = "Closing $ProductName$ellipsis"
    } elseif ($state.lastFinishedStep -and $stepAfter.ContainsKey($state.lastFinishedStep)) {
      $state.phase = "installing"
      $subline.Text = $stepAfter[$state.lastFinishedStep]
    } else {
      $state.phase = "installing"
      $subline.Text = "Installing $ProductName $TargetVersion$ellipsis"
    }
    Write-Heartbeat $state.phase

    $installed = $null
    if ($state.installerGoneAt -and ($now - $state.installerGoneAt).TotalSeconds -ge 20) {
      $installed = Get-InstalledVersion
      if ($installed -eq $TargetVersion) {
        Show-Failure "$ProductName $TargetVersion is installed" "It did not open on its own. Open it to finish."
      } else {
        $stillOn = if ($installed) { $installed } elseif ($CurrentVersion) { $CurrentVersion } else { "the previous version" }
        Show-Failure "The update did not install" "$ProductName is still on $stillOn. Open it and choose Restart to retry."
      }
      return
    }
    # The installer never showed up (blocked, or it failed before we saw it).
    if (-not $state.installerSeen -and $state.parentGoneAt -and ($now - $state.parentGoneAt).TotalSeconds -ge 60) {
      $installed = Get-InstalledVersion
      if ($installed -eq $TargetVersion) {
        Show-Failure "$ProductName $TargetVersion is installed" "It did not open on its own. Open it to finish."
      } else {
        Show-Failure "The update did not start" "The installer never ran. Open $ProductName and choose Restart to retry."
      }
      return
    }
    if (($now - $startedAt).TotalSeconds -ge $TimeoutSeconds) {
      Show-Failure "The update is taking too long" "Open $ProductName to check where it got to."
    }
  } catch {
    Write-ProgressLog "tick_error" $_.Exception.Message
  }
})

$window.Add_Closed({
  $timer.Stop()
  Remove-Heartbeat
  Write-ProgressLog "closed" ("done=" + $state.done + " phase=" + $state.phase)
})

Write-ProgressLog "started" "target=$TargetVersion parent=$ParentPid installer=$InstallerPath"
Write-Heartbeat "closing"
$timer.Start()
[void]$window.ShowDialog()
