param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId
)

$ErrorActionPreference = 'Stop'

$NativeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HostScript = Join-Path $NativeDir 'host.cjs'
$HostWrapper = Join-Path $NativeDir 'host-wrapper.cmd'
$ManifestPath = Join-Path $NativeDir 'com.pi.annotate.json'

$NodeCommand = Get-Command node -ErrorAction Stop
$NodePath = $NodeCommand.Source

if (-not (Test-Path -LiteralPath $HostScript)) {
  throw "Cannot find native host script: $HostScript"
}

$wrapper = @"
@echo off
""$NodePath"" ""%~dp0host.cjs"" %*
"@
[System.IO.File]::WriteAllText($HostWrapper, $wrapper, [System.Text.ASCIIEncoding]::new())

$manifest = [ordered]@{
  name = 'com.pi.annotate'
  description = 'Pi Annotate native messaging host'
  path = $HostWrapper
  type = 'stdio'
  allowed_origins = [string[]]@("chrome-extension://$ExtensionId/")
}
$manifestJson = ($manifest | ConvertTo-Json -Depth 5) + [Environment]::NewLine
[System.IO.File]::WriteAllText($ManifestPath, $manifestJson, [System.Text.UTF8Encoding]::new($false))

$registryKeys = @(
  'HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pi.annotate',
  'HKCU\Software\Google\Chrome for Testing\NativeMessagingHosts\com.pi.annotate',
  'HKCU\Software\Chromium\NativeMessagingHosts\com.pi.annotate',
  'HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.pi.annotate'
)

foreach ($key in $registryKeys) {
  & reg.exe add $key /ve /t REG_SZ /d $ManifestPath /f | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to register native host at $key"
  }
  Write-Host "Installed native host manifest registry entry: $key -> $ManifestPath"
}

Write-Host "Using node at: $NodePath"
Write-Host "Created wrapper: $HostWrapper"
Write-Host "Created manifest: $ManifestPath"
Write-Host "Fully quit and reopen the browser you loaded the extension in."
