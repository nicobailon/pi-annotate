param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId,
  [switch]$EnableWslBridge,
  [ValidateRange(1, 65535)]
  [int]$WslBridgePort = 43173
)

$ErrorActionPreference = 'Stop'

$NativeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HostScript = Join-Path $NativeDir 'host.cjs'
$HostWrapper = Join-Path $NativeDir 'host-wrapper.cmd'
$ManifestPath = Join-Path $NativeDir 'com.pi.annotate.json'

if (-not (Test-Path -LiteralPath $HostScript)) {
  throw "Cannot find native host script: $HostScript"
}

$NodeCommand = Get-Command node -ErrorAction Stop
$NodePath = (& $NodeCommand.Source -p 'process.execPath').Trim()
if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  throw 'Cannot find a Node.js executable for the native host'
}

$wrapperLines = @('@echo off')
$WslBridgeToken = ''
if ($EnableWslBridge) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $WslBridgeToken = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  $wrapperLines += "set `"PI_ANNOTATE_WSL_TOKEN=$WslBridgeToken`""
  $wrapperLines += 'set "PI_ANNOTATE_WSL_HOST=127.0.0.1"'
  $wrapperLines += "set `"PI_ANNOTATE_WSL_PORT=$WslBridgePort`""
}
$wrapperLines += "`"$NodePath`" `"%~dp0host.cjs`" %*"
$wrapper = ($wrapperLines -join "`r`n") + "`r`n"
[System.IO.File]::WriteAllText($HostWrapper, $wrapper, [System.Text.UTF8Encoding]::new($false))

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
  'HKCU\Software\Chromium\NativeMessagingHosts\com.pi.annotate'
)

foreach ($key in $registryKeys) {
  & reg.exe add $key /ve /t REG_SZ /d $ManifestPath /f | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to register native host at $key"
  }
  Write-Host "Installed native host manifest registry entry: $key -> $ManifestPath"
}

Write-Host "Using node at: $NodePath"
if ($EnableWslBridge) {
  Write-Host "WSL bridge enabled on Windows loopback port $WslBridgePort."
  Write-Host "In WSL, run these commands before starting pi:"
  Write-Host "export PI_ANNOTATE_WSL_BRIDGE=127.0.0.1:$WslBridgePort"
  Write-Host "export PI_ANNOTATE_WSL_TOKEN=$WslBridgeToken"
}
Write-Host "Fully quit and reopen the browser you loaded the extension in."
