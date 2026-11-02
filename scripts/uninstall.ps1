#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$DshCli, [string]$DshHome, [string]$Profile = 'desktop')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$environment = Resolve-BillingEnvironment -DshCli $DshCli -DshHome $DshHome -Profile $Profile
if (-not $PSCmdlet.ShouldProcess($environment.ProfileDir, '卸载 dsh-billing-ledger，保留会话与账本')) { return }
$backup = Backup-BillingProfile -Environment $environment -Operation 'uninstall'
Set-BillingBundle -Manifest $environment.Manifest -Enabled $false
$previousHome = $env:DSH_HOME
try {
    $env:DSH_HOME = $environment.Home
    & $environment.Cli plugin --profile $Profile remove dsh-billing-ledger --config.ignore-scripts=true
    if ($LASTEXITCODE -ne 0) { throw "依赖移除失败；启用项已移除，备份位于 $backup。请重新打开 DSH 后检查。" }
} finally { $env:DSH_HOME = $previousHome }
Write-Output '插件已卸载，请重新打开 DSH。会话、账本和安装包缓存均保留。'
Write-Output "配置备份：$backup"
