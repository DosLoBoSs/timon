# Pauses the Timon background service while the installer replaces its files.
# Run by installer.nsh (timonPauseService), never by hand: elevated when
# Windows grants it, and once more without elevation when it does not.
#
# Why elevated: the service runs under a Task Scheduler S4U logon, in session 0.
# The per-user installer sees those Timon.exe processes (same user) but cannot
# end them, and looped on "Timon cannot be closed" (0.1.2-rc.2 update,
# 27/09/2026). The task is disabled first: its 5-minute repeating trigger would
# otherwise start the daemon again from half-replaced files.
#
# Why it also runs unelevated: an account Windows refuses S4U for (a standard
# account on an Entra-joined PC) gets an Interactive task, which runs the daemon
# in the user's own session; that user may disable the task and end the daemon
# without elevation. Left running, the daemon kept its files open while the
# installer replaced them, and the next launch failed on a missing `ffmpeg.dll`
# (0.1.5 update, 21/10/2026).
#
# The first run (stop phase) ends the service and starts a detached copy of
# itself (resume phase), which waits for the installer to exit and then enables
# and starts the task again if it still exists: an uninstall deletes it.
param(
  # The installer's process: the resume waits for it, and its owner is the
  # account whose Timon this is.
  [Parameter(Mandatory = $true)][int]$InstallerPid,
  [Parameter(Mandatory = $true)][string]$Exe,
  # The application directory: what remains of this installation is found by
  # the paths under it on a command line. Empty: only the daemon is ended.
  [string]$InstallDir = '',
  # Where a failure is written. The stop phase computes it and hands it to the
  # resume phase, whose environment comes from WMI, not from the installer.
  [string]$Log = '',
  [switch]$Resume
)
$task = 'TimonOrchestrator'
if (-not $Log -and $env:USERPROFILE) { $Log = Join-Path $env:USERPROFILE '.timon\tmp\timon-service-pause.log' }
$note = {
  param([string]$text)
  if (-not $Log) { return }
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Log) -ErrorAction Stop | Out-Null
    Add-Content -LiteralPath $Log -Value ('{0} {1}' -f (Get-Date -Format o), $text) -ErrorAction Stop
  } catch { }
}

# Not under SilentlyContinue: it hid why a killed installer left the task
# Disabled and the daemon stopped (VM, 06/11/2026). Each call reports its own
# error, is tried again, and the last failure is written to $Log.
if ($Resume) {
  Wait-Process -Id $InstallerPid -ErrorAction Ignore
  # Wait-Process gives up at once on a process it may not open (an elevated
  # installer seen from an unelevated resume): poll until no installer runs.
  while (Get-Process -Id $InstallerPid -ErrorAction Ignore) { Start-Sleep -Seconds 2 }
  $failure = ''
  foreach ($attempt in 1..3) {
    try {
      $state = (Get-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction Stop).State
      # The state is read, not assumed: a task an earlier pause left Disabled
      # is enabled too, and a running one is not started twice.
      if ($state -eq 'Disabled') { Enable-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction Stop | Out-Null }
      if ($state -ne 'Running') { Start-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction Stop }
      if ((Get-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction Stop).State -eq 'Disabled') { throw 'the task is still disabled' }
      $failure = ''
      break
    } catch {
      # An uninstall deleted the task: nothing to resume.
      if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { $failure = ''; break }
      $failure = "attempt $attempt`: $($_.Exception.Message)"
      if ($attempt -lt 3) { Start-Sleep -Seconds 5 }
    }
  }
  if ($failure) { & $note "resume: could not enable and start $task ($failure)" }
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction Ignore
  exit 0
}

$ErrorActionPreference = 'SilentlyContinue'

Disable-ScheduledTask -TaskName $task -TaskPath '\' | Out-Null
Stop-ScheduledTask -TaskName $task -TaskPath '\'

# Whose Timon this is: the owner of the installer's process, by SID. Never a
# name. The installer passed `-User` built from the NSIS form that is replaced
# when the installer is COMPILED, so every installer carried the account of the
# build machine: on a tester's PC the comparison was always false, nothing was
# ended, and the previous daemon outlived the update holding its port
# (0.1.7 to 0.1.8). A SID also holds for a Microsoft Entra account, and for an
# elevation granted by another account, where this script runs as the
# administrator while the installer still belongs to the user.
$sidOf = {
  param($process)
  try { (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop).Sid } catch { $null }
}
$account = $null
$installer = Get-CimInstance Win32_Process -Filter "ProcessId=$InstallerPid"
if ($installer) { $account = & $sidOf $installer }
# The installer could not be read (it is elevated, this run is not): this
# process then runs as the very account that started it.
if (-not $account) { $account = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
$mine = { param($process) $account -and ((& $sidOf $process) -eq $account) }

# The daemon runs on the Node the package ships (resources\node\node.exe);
# a package before it ran it on $Exe as Node. An update from one to the other
# finds either, so both are ours.
$runtimes = @($Exe, 'node.exe')
$end = { param($process) & taskkill.exe /F /T /PID $process.ProcessId | Out-Null }

# Stop-ScheduledTask ends the launcher and leaves its daemon orphaned: end the
# launcher's tree, then every daemon of this account it left behind, in
# whatever session it runs (session 0 for S4U, the user's own for an
# Interactive task) and wherever it is installed. The daemon names its entry
# point on its command line; the window (no boot.js) is left to the installer's
# own "close the application".
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'cmd.exe' -and $_.CommandLine -and
  $_.CommandLine.ToLowerInvariant().Contains('\run\timon-service.cmd') -and (& $mine $_)
} | ForEach-Object { & $end $_ }
Get-CimInstance Win32_Process | Where-Object {
  $runtimes -contains $_.Name -and $_.CommandLine -and
  $_.CommandLine.ToLowerInvariant().Contains('\dist\boot.js') -and (& $mine $_)
} | ForEach-Object { & $end $_ }

# What runs from THIS installation is ended whoever owns it: the installer is
# about to replace those very files, and the path alone says they are Timon's.
# That is the Node the package ships, wherever its script lives, and $Exe or
# node.exe running a file of the installation as Node: the daemon, its web
# server (resources\app\...\server.cjs), the browser helper of a mission
# (bin\browser-mcp.mjs), the terminal host (detached on purpose). No tree
# reaches the last three once the daemon is gone, and they kept the installer
# looping on "Timon cannot be closed" after the user had quit the app (0.1.5
# update, 22/10/2026). The window and Electron's own helpers (--type=) carry
# none of these paths. Two passes: a child whose parent went first in a pass
# has no tree left to be ended with.
$root = $InstallDir.TrimEnd('\').ToLowerInvariant()
$shipped = "$root\resources\node\"
$needles = @("$root\resources\orchestrator\", "$root\resources\app\")
$fromInstallation = {
  param($process)
  if (-not $root -or $process.ProcessId -eq $PID) { return $false }
  if ($process.ExecutablePath -and $process.ExecutablePath.ToLowerInvariant().StartsWith($shipped)) { return $true }
  if ($runtimes -notcontains $process.Name -or -not $process.CommandLine -or $process.CommandLine.Contains('--type=')) { return $false }
  $line = $process.CommandLine.ToLowerInvariant()
  foreach ($needle in $needles) { if ($line.Contains($needle)) { return $true } }
  $false
}
$ofInstallation = { Get-CimInstance Win32_Process | Where-Object { & $fromInstallation $_ } }
foreach ($pass in 1..2) {
  $found = @(& $ofInstallation)
  if ($found.Count -eq 0) { break }
  $found | ForEach-Object { & $end $_ }
  Start-Sleep -Seconds 1
}

# The installer deletes its plugins directory on exit: the resume phase runs
# from its own copy.
$copy = Join-Path ([IO.Path]::GetTempPath()) ("timon-service-resume-{0}.ps1" -f $InstallerPid)
Copy-Item -LiteralPath $PSCommandPath -Destination $copy -Force
$powershell = Join-Path $PSHOME 'powershell.exe'
$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$copy`" -Resume " +
  "-InstallerPid $InstallerPid -Exe `"$Exe`""
# An empty quoted value is dropped from a -File command line, and -Log would
# then swallow nothing and fail the whole resume.
if ($Log) { $arguments += " -Log `"$Log`"" }
# A child of this process stays in its job object and dies with it: an SSH
# session's job took the waiting resume down with it (VM, 06/11/2026). WMI
# creates the process from its own service, outside any job, with this
# process's token (the elevation it holds) and its window hidden from the start.
$startup = New-CimInstance -CimClass (Get-CimClass -ClassName Win32_ProcessStartup) -Property @{ ShowWindow = [uint16]0 } -ClientOnly
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = "`"$powershell`" $arguments"; ProcessStartupInformation = $startup
}
if (-not $created -or $created.ReturnValue -ne 0) {
  & $note ("pause: WMI could not start the resume (result {0}), started as a child" -f $created.ReturnValue)
  Start-Process -WindowStyle Hidden -FilePath $powershell -ArgumentList $arguments
}
exit 0
