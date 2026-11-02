# Shared by the ready-to-install Windows release. PowerShell 5.1 and 7.
function Resolve-BillingEnvironment {
    param([string]$DshCli, [string]$DshHome, [string]$Profile)
    if ($env:OS -ne 'Windows_NT') { throw '此安装脚本仅支持 Windows。' }
    if ($Profile -notmatch '^[a-zA-Z0-9_-]+$') { throw '无效的 profile 名称。' }
    if (-not $DshHome) { $DshHome = $env:DSH_HOME }
    if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
    $resolvedHome = [IO.Path]::GetFullPath($DshHome)
    $profileDir = Join-Path $resolvedHome ('profiles/' + $Profile)
    $manifest = Join-Path $profileDir 'package.json'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
        throw "未找到 profile：$manifest。请先启动一次 DSH；自定义位置可使用 -DshHome 参数。"
    }
    if (-not $DshCli) {
        $candidates = New-Object 'System.Collections.Generic.List[string]'
        foreach ($process in @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
            if ($process.Path) { $candidates.Add((Join-Path (Split-Path $process.Path) 'resources/runtime/cli/bin/dsh.cmd')) }
        }
        foreach ($shortcut in @(
            (Join-Path ([Environment]::GetFolderPath('Desktop')) 'DeepSeek Harness.lnk'),
            (Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs/DeepSeek Harness.lnk'),
            (Join-Path $env:ProgramData 'Microsoft/Windows/Start Menu/Programs/DeepSeek Harness.lnk')
        )) {
            if (Test-Path -LiteralPath $shortcut) {
                try {
                    $shell = New-Object -ComObject WScript.Shell
                    $target = $shell.CreateShortcut($shortcut).TargetPath
                    if ($target) { $candidates.Add((Join-Path (Split-Path $target) 'resources/runtime/cli/bin/dsh.cmd')) }
                } catch { }
            }
        }
        foreach ($command in @(Get-Command dsh.cmd, dsh.exe -CommandType Application -ErrorAction SilentlyContinue)) {
            $candidates.Add($command.Source)
        }
        $DshCli = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    }
    if (-not $DshCli -or -not (Test-Path -LiteralPath $DshCli -PathType Leaf)) {
        throw '没有找到 DSH CLI。请用 -DshCli 参数指定安装目录中的 resources/runtime/cli/bin/dsh.cmd。'
    }
    return [pscustomobject]@{ Cli = [IO.Path]::GetFullPath($DshCli); Home = $resolvedHome; ProfileDir = $profileDir; Manifest = $manifest }
}

function Backup-BillingProfile {
    param($Environment, [string]$Operation)
    $backup = Join-Path $Environment.Home ('backups/billing-ledger/' + $Operation + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    foreach ($name in @('package.json','cordis.patch.yml','pnpm-lock.yaml','pnpm-workspace.yaml')) {
        $source = Join-Path $Environment.ProfileDir $name
        if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $backup $name) }
    }
    return $backup
}

function Get-BillingFileHash {
    param([string]$Path)
    # .NET reads are unaffected by Windows PowerShell 5.1's WhatIf propagation.
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','') }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Set-BillingBundle {
    param([string]$Manifest, [bool]$Enabled)
    $document = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
    if (-not $document.dsh -or -not $document.dsh.profile) { throw 'profile 清单缺少 dsh.profile；原配置备份已保留。' }
    $selected = @($document.dsh.profile.bundles)
    if ($Enabled) {
        if ($selected -contains 'dsh-billing-ledger') { return }
        $selected = @($selected) + @('dsh-billing-ledger')
    } else { $selected = @($selected | Where-Object { $_ -ne 'dsh-billing-ledger' }) }
    $document.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @($selected) -Force
    [IO.File]::WriteAllText($Manifest, (($document | ConvertTo-Json -Depth 100) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
}
