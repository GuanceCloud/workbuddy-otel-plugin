[CmdletBinding()]
param(
  [string]$Version = "latest",
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
  [switch]$NoConfig
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = if ($env:WORKBUDDY_OTEL_REPO) { $env:WORKBUDDY_OTEL_REPO } else { "GuanceCloud/workbuddy-otel-plugin" }
if ($env:WORKBUDDY_OTEL_VERSION) { $Version = $env:WORKBUDDY_OTEL_VERSION }
$AssetName = if ($env:WORKBUDDY_OTEL_RELEASE_ASSET_NAME) { $env:WORKBUDDY_OTEL_RELEASE_ASSET_NAME } else { "workbuddy-otel-plugin.zip" }
if ($Version -ne "latest" -and -not $Version.StartsWith("v")) { $Version = "v$Version" }

if ($env:WORKBUDDY_OTEL_ARCHIVE_URL) {
  $ArchiveUrl = $env:WORKBUDDY_OTEL_ARCHIVE_URL
} elseif ($Version -eq "latest") {
  $ArchiveUrl = "https://github.com/$Repo/releases/latest/download/$AssetName"
} else {
  $ArchiveUrl = "https://github.com/$Repo/releases/download/$Version/$AssetName"
}

$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ("workbuddy-otel-plugin-" + [guid]::NewGuid().ToString("N"))
$ArchivePath = Join-Path $TempRoot $AssetName
$ExtractPath = Join-Path $TempRoot "repo"

try {
  [IO.Directory]::CreateDirectory($ExtractPath) | Out-Null
  Write-Host "Downloading $ArchiveUrl"
  Invoke-WebRequest -UseBasicParsing -Uri $ArchiveUrl -OutFile $ArchivePath
  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractPath -Force

  $Installer = Join-Path $ExtractPath "scripts\install.ps1"
  if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) {
    throw "Release archive does not contain scripts/install.ps1"
  }

  $InstallParameters = @{ Refresh = $true; Header = $Header; Tag = $Tag }
  if ($PSBoundParameters.ContainsKey("Type")) { $InstallParameters.Type = $Type }
  if ($Endpoint) { $InstallParameters.Endpoint = $Endpoint }
  if ($XToken) { $InstallParameters.XToken = $XToken }
  if ($TracePath) { $InstallParameters.TracePath = $TracePath }
  if ($MetricsPath) { $InstallParameters.MetricsPath = $MetricsPath }
  if ($ConfigDir) { $InstallParameters.ConfigDir = $ConfigDir }
  if ($ConfigFile) { $InstallParameters.ConfigFile = $ConfigFile }
  if ($EnableScript) { $InstallParameters.EnableScript = $true }
  if ($DisableScript) { $InstallParameters.DisableScript = $true }
  if ($CaptureContent) { $InstallParameters.CaptureContent = $true }
  if ($NoCaptureContent) { $InstallParameters.NoCaptureContent = $true }
  if ($EnableDebug) { $InstallParameters.EnableDebug = $true }
  if ($NoDebug) { $InstallParameters.NoDebug = $true }
  if ($NoConfig) { $InstallParameters.NoConfig = $true }

  Write-Host "Installing plugin from temporary archive"
  $PreviousRepoRoot = $env:REPO_ROOT
  try {
    $env:REPO_ROOT = $ExtractPath
    $InstallerScript = [scriptblock]::Create([IO.File]::ReadAllText($Installer))
    & $InstallerScript @InstallParameters
    if (-not $?) { throw "Plugin installer failed." }
  } finally {
    $env:REPO_ROOT = $PreviousRepoRoot
  }
} finally {
  if (Test-Path -LiteralPath $TempRoot) {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
