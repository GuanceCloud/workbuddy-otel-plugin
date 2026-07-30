[CmdletBinding()]
param(
  [switch]$Refresh,
  [ValidateSet("gtrace", "otlp", "otel")][string]$Type = "gtrace",
  [string]$Endpoint,
  [string]$XToken,
  [string]$TracePath,
  [string]$MetricsPath,
  [string[]]$Header = @(),
  [string[]]$Tag = @(),
  [string]$ConfigDir,
  [string]$ConfigFile,
  [switch]$EnableScript,
  [switch]$DisableScript,
  [switch]$CaptureContent,
  [switch]$NoCaptureContent,
  [switch]$EnableDebug,
  [switch]$NoDebug,
  [switch]$NoConfig,
  [switch]$Uninstall,
  [switch]$Purge
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-InstallLog([string]$Message) {
  Write-Host "[install] $Message"
}

function Remove-PathIfPresent([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Resolve-Node([string]$ProfileDir) {
  if ($env:WORKBUDDY_OTEL_NODE) {
    if (-not (Test-Path -LiteralPath $env:WORKBUDDY_OTEL_NODE -PathType Leaf)) {
      throw "WORKBUDDY_OTEL_NODE does not exist: $($env:WORKBUDDY_OTEL_NODE)"
    }
    return (Resolve-Path -LiteralPath $env:WORKBUDDY_OTEL_NODE).Path
  }

  $candidates = @()
  $managedRoot = Join-Path $ProfileDir "binaries\node\versions"
  if (Test-Path -LiteralPath $managedRoot -PathType Container) {
    $candidates += Get-ChildItem -LiteralPath $managedRoot -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending |
      ForEach-Object { $_.FullName }
  }
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) { $candidates += $command.Source }
  $candidates += @(
    (Join-Path $env:ProgramFiles "nodejs\node.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
  }

  throw @"
Missing required command: node

workbuddy-otel-plugin requires Node.js >= 22. Install the WorkBuddy managed
Node.js runtime, install Node.js 22+, or set WORKBUDDY_OTEL_NODE explicitly.
"@
}

if ($EnableScript -and $DisableScript) {
  throw "-EnableScript and -DisableScript cannot be used together."
}
if ($CaptureContent -and $NoCaptureContent) {
  throw "-CaptureContent and -NoCaptureContent cannot be used together."
}
if ($EnableDebug -and $NoDebug) {
  throw "-EnableDebug and -NoDebug cannot be used together."
}
if ($Purge -and -not $Uninstall) {
  throw "-Purge requires -Uninstall."
}

$RepoRoot = if ($env:REPO_ROOT) { $env:REPO_ROOT } else { Split-Path -Parent $PSScriptRoot }
if (-not $ConfigDir) {
  if ($env:WORKBUDDY_CONFIG_DIR) { $ConfigDir = $env:WORKBUDDY_CONFIG_DIR }
  elseif ($env:CODEBUDDY_CONFIG_DIR) { $ConfigDir = $env:CODEBUDDY_CONFIG_DIR }
  else { $ConfigDir = Join-Path $env:USERPROFILE ".workbuddy" }
}
if (-not $ConfigFile) {
  $ConfigFile = if ($env:GTRACE_CONFIG_FILE) { $env:GTRACE_CONFIG_FILE } else { Join-Path $ConfigDir "gtrace.json" }
}
if (-not $Endpoint) { $Endpoint = if ($env:GTRACE_ENDPOINT) { $env:GTRACE_ENDPOINT } else { $env:WORKBUDDY_OTEL_ENDPOINT } }
if (-not $XToken) { $XToken = if ($env:GTRACE_X_TOKEN) { $env:GTRACE_X_TOKEN } else { $env:X_TOKEN } }
if (-not $TracePath) { $TracePath = if ($env:GTRACE_TRACE_PATH) { $env:GTRACE_TRACE_PATH } else { $env:WORKBUDDY_OTEL_TRACE_PATH } }
if (-not $MetricsPath) { $MetricsPath = if ($env:GTRACE_METRICS_PATH) { $env:GTRACE_METRICS_PATH } else { $env:WORKBUDDY_OTEL_METRICS_PATH } }
$TypeExplicit = $PSBoundParameters.ContainsKey("Type") -or [bool]$env:WORKBUDDY_OTEL_INSTALL_TYPE
if (-not $PSBoundParameters.ContainsKey("Type") -and $env:WORKBUDDY_OTEL_INSTALL_TYPE) { $Type = $env:WORKBUDDY_OTEL_INSTALL_TYPE }
if ($Type -eq "otel") { $Type = "otlp" }
if (@("gtrace", "otlp") -notcontains $Type) { throw "Unsupported -Type: $Type. Supported values: gtrace, otlp" }
$ConfigRequested = [bool]($Endpoint -or $XToken -or $TracePath -or $MetricsPath -or $Header.Count -gt 0 -or $Tag.Count -gt 0 -or $EnableScript -or $DisableScript -or $CaptureContent -or $NoCaptureContent -or $EnableDebug -or $NoDebug)

foreach ($assignment in @($Tag) + @($Header)) {
  if (-not $assignment -or $assignment.IndexOf("=") -le 0) {
    throw "Expected KEY=VALUE, got: $assignment"
  }
}

$MarketplaceDir = Join-Path $ConfigDir "plugins\marketplaces\guance"
$TargetDir = Join-Path $MarketplaceDir "plugins\workbuddy-otel-plugin"
$CachePluginDir = Join-Path $ConfigDir "plugins\cache\guance\workbuddy-otel-plugin"
$SettingsFile = Join-Path $ConfigDir "settings.json"
$InstalledPluginsFile = Join-Path $ConfigDir "plugins\installed_plugins.json"
$DataDir = Join-Path $ConfigDir "plugins\data\workbuddy-otel-plugin"
$PluginSelector = "workbuddy-otel-plugin@guance"
$ConfigHelper = Join-Path $RepoRoot "scripts\install-config.js"
$HookSource = Join-Path $RepoRoot "src\workbuddy-hook.js"
$PluginVersion = $null
$CacheDir = $null
if (-not (Test-Path -LiteralPath $ConfigHelper -PathType Leaf)) { throw "Cannot find $ConfigHelper" }

$NodeBin = Resolve-Node $ConfigDir
$NodeVersion = (& $NodeBin --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $NodeVersion -notmatch '^v?(\d+)(?:\.|$)') {
  throw "Unable to determine Node.js version at $NodeBin. Output: $NodeVersion"
}
if ([int]$Matches[1] -lt 22) {
  throw "Node.js >= 22 is required. Found: $NodeVersion at $NodeBin"
}

function Update-PluginSetting([bool]$Enabled) {
  $env:WORKBUDDY_SETTINGS_FILE_RUNTIME = $SettingsFile
  $env:WORKBUDDY_PLUGIN_SELECTOR_RUNTIME = $PluginSelector
  $action = if ($Enabled) { "enable-plugin" } else { "disable-plugin" }
  & $NodeBin $ConfigHelper $action
  if ($LASTEXITCODE -ne 0) { throw "Failed to update $SettingsFile" }
}

function Update-PluginFallback([string]$Action) {
  $env:WORKBUDDY_SETTINGS_FILE_RUNTIME = $SettingsFile
  $env:WORKBUDDY_INSTALLED_PLUGINS_FILE_RUNTIME = $InstalledPluginsFile
  $env:WORKBUDDY_PLUGIN_SELECTOR_RUNTIME = $PluginSelector
  $env:WORKBUDDY_PLUGIN_ROOT_RUNTIME = $CacheDir
  $env:WORKBUDDY_PLUGIN_VERSION_RUNTIME = $PluginVersion
  & $NodeBin $ConfigHelper $Action
  if ($LASTEXITCODE -ne 0) { throw "Failed to update fallback plugin state" }
}

function Get-PluginVersion() {
  $version = (& $NodeBin -p "require(process.argv[1]).version" (Join-Path $RepoRoot "package.json") | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $version) { throw "Failed to read plugin version from package.json" }
  return $version
}

function Resolve-PluginCli() {
  foreach ($name in @("workbuddy", "codebuddy")) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
  }
  return $null
}

function Activate-PluginWithCli([string]$Cli) {
  & $Cli plugin marketplace add $MarketplaceDir | Out-Null
  & $Cli plugin marketplace update guance | Out-Null
  & $Cli plugin install $PluginSelector --scope user | Out-Null
  if ($LASTEXITCODE -eq 0) { return $true }
  & $Cli plugin enable $PluginSelector | Out-Null
  return ($LASTEXITCODE -eq 0)
}

function Test-WorkBuddyRunning() {
  $isMac = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::OSX)
  if (-not $isMac) { return $false }
  @(Get-Process -Name "WorkBuddy", "CodeBuddy", "workbuddy", "codebuddy" -ErrorAction SilentlyContinue).Count -gt 0
}

if ($Uninstall) {
  if (Test-WorkBuddyRunning) {
    throw "WorkBuddy is running. Quit WorkBuddy completely before uninstalling, then retry. This prevents macOS from writing stale plugin settings back over the uninstall changes."
  }
  Remove-PathIfPresent $TargetDir
  Remove-PathIfPresent $CachePluginDir
  Update-PluginFallback "disable-plugin-fallback"
  if ($Purge) {
    Remove-PathIfPresent $DataDir
    Remove-PathIfPresent $ConfigFile
    Write-InstallLog "removed upload config and plugin state"
  }
  Write-InstallLog "uninstalled $PluginSelector from $ConfigDir"
  return
}

if (-not (Test-Path -LiteralPath $HookSource -PathType Leaf)) {
  throw "Cannot find WorkBuddy plugin runtime under $RepoRoot"
}
if (Test-WorkBuddyRunning) {
  throw "WorkBuddy is running. Quit WorkBuddy completely before installing, then retry. This prevents macOS from writing stale plugin settings back over the installer changes."
}
[IO.Directory]::CreateDirectory((Join-Path $MarketplaceDir ".codebuddy-plugin")) | Out-Null
Remove-PathIfPresent $TargetDir
[IO.Directory]::CreateDirectory($TargetDir) | Out-Null
foreach ($name in @(".codebuddy-plugin", "bin", "hooks", "src")) {
  Copy-Item -LiteralPath (Join-Path $RepoRoot $name) -Destination (Join-Path $TargetDir $name) -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $RepoRoot "package.json") -Destination (Join-Path $TargetDir "package.json") -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "config\marketplace.installed.json") -Destination (Join-Path $MarketplaceDir ".codebuddy-plugin\marketplace.json") -Force

$PluginVersion = Get-PluginVersion
$CacheDir = Join-Path $CachePluginDir $PluginVersion
Remove-PathIfPresent $CacheDir
[IO.Directory]::CreateDirectory($CacheDir) | Out-Null
foreach ($name in @(".codebuddy-plugin", "bin", "hooks", "src")) {
  Copy-Item -LiteralPath (Join-Path $RepoRoot $name) -Destination (Join-Path $CacheDir $name) -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $RepoRoot "package.json") -Destination (Join-Path $CacheDir "package.json") -Force

if (Test-Path -LiteralPath $SettingsFile -PathType Leaf) {
  Copy-Item -LiteralPath $SettingsFile -Destination "$SettingsFile.workbuddy-otel-plugin.bak" -Force
}
$PluginCli = Resolve-PluginCli
if ($PluginCli) {
  if (Activate-PluginWithCli $PluginCli) {
    Update-PluginSetting $true
    Update-PluginFallback "remove-plugin-fallback-hooks"
    Write-InstallLog "activated plugin with CLI: $PluginCli"
  } else {
    Update-PluginFallback "enable-plugin-fallback"
    Write-InstallLog "CLI activation failed; updated plugin registry and $SettingsFile directly"
  }
} else {
  Update-PluginFallback "enable-plugin-fallback"
  Write-InstallLog "plugin CLI not found; updated plugin registry and $SettingsFile directly"
}
$verb = if ($Refresh) { "refreshed" } else { "installed" }
Write-InstallLog "$verb plugin: $TargetDir"
Write-InstallLog "updated plugin cache: $CacheDir"

$ConfigAlreadyExists = Test-Path -LiteralPath $ConfigFile -PathType Leaf
if (-not $TracePath -and ($Endpoint -or -not $ConfigAlreadyExists -or $TypeExplicit)) {
  $TracePath = if ($Type -eq "gtrace") { "v1/write/otel-llm" } else { "v1/traces" }
}
if (-not $MetricsPath -and ($Endpoint -or -not $ConfigAlreadyExists -or $TypeExplicit)) {
  $MetricsPath = if ($Type -eq "gtrace") { "v1/write/otel-metrics" } else { "v1/metrics" }
}

$ScriptEnabled = if ($EnableScript) { "true" } elseif ($DisableScript) { "false" } else { "" }
$CaptureValue = if ($CaptureContent) { "true" } elseif ($NoCaptureContent) { "false" } else { "" }
$DebugValue = if ($EnableDebug) { "true" } elseif ($NoDebug) { "false" } else { "" }
if ($NoConfig) {
  Write-InstallLog "skipped config because -NoConfig was set"
} elseif ($ConfigAlreadyExists -or $ConfigRequested) {
  $env:GTRACE_CONFIG_FILE_RUNTIME = $ConfigFile
  $env:GTRACE_ENDPOINT_RUNTIME = $Endpoint
  $env:GTRACE_TRACE_PATH_RUNTIME = $TracePath
  $env:GTRACE_METRICS_PATH_RUNTIME = $MetricsPath
  $env:GTRACE_INSTALL_TYPE_RUNTIME = if (-not $ConfigAlreadyExists -or $Endpoint -or $TypeExplicit) { $Type } else { "" }
  $env:GTRACE_X_TOKEN_RUNTIME = $XToken
  $env:GTRACE_SCRIPT_ENABLED_RUNTIME = $ScriptEnabled
  $env:GTRACE_CAPTURE_CONTENT_RUNTIME = $CaptureValue
  $env:GTRACE_DEBUG_RUNTIME = $DebugValue
  $env:GTRACE_TAGS_RUNTIME = ConvertTo-Json -InputObject @($Tag) -Compress
  $env:GTRACE_HEADERS_RUNTIME = ConvertTo-Json -InputObject @($Header) -Compress
  & $NodeBin $ConfigHelper write-gtrace-config
  if ($LASTEXITCODE -ne 0) { throw "Failed to update $ConfigFile" }
  Write-InstallLog "updated $ConfigFile"
  if ($Endpoint) { Write-InstallLog "configured endpoint: $($Endpoint.TrimEnd('/'))" }
  if ($TracePath) { Write-InstallLog "configured trace path: $TracePath" }
  if ($MetricsPath) { Write-InstallLog "configured metrics path: $MetricsPath" }
  if ($XToken) { Write-InstallLog "configured X-Token: <redacted>" }
} else {
  Write-InstallLog "skipped config because -Endpoint was not provided"
}

Write-Host ""
Write-Host "Installation complete."
Write-Host "Plugin: $PluginSelector"
Write-Host "Configuration: $ConfigFile"
Write-Host "Restart WorkBuddy or run /reload-plugins so the Hooks are reloaded."
