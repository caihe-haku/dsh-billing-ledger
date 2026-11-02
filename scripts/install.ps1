#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$DshCli, [string]$DshHome, [string]$Profile = 'desktop', [string]$PackageFile)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$releaseRoot = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $releaseRoot 'release.json'))) { throw '请从 GitHub Releases 下载现成 Windows 安装包并完整解压；开发者可先运行 npm run release。' }
$releaseInfo = Get-Content -LiteralPath (Join-Path $releaseRoot 'release.json') -Raw | ConvertFrom-Json
if (-not $PackageFile) { $PackageFile = Join-Path $releaseRoot $releaseInfo.package }
if (-not (Test-Path -LiteralPath $PackageFile -PathType Leaf)) { throw '没有找到现成安装包，请从 GitHub Releases 下载 Windows 安装包并完整解压。' }
$PackageFile = [IO.Path]::GetFullPath($PackageFile)
$actualHash = Get-BillingFileHash -Path $PackageFile
if ($actualHash -ine $releaseInfo.sha256) { throw '安装包 SHA-256 与发布清单不一致，请重新下载完整发布包。' }
$environment = Resolve-BillingEnvironment -DshCli $DshCli -DshHome $DshHome -Profile $Profile
$runtime = ((& $environment.Cli --version) | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw '无法读取 DSH 版本。' }
if (@($releaseInfo.supportedDsh) -notcontains $runtime) { throw "DSH $runtime 未经此插件版本验证；支持版本：$($releaseInfo.supportedDsh -join ', ')。" }
$stablePackage = Join-Path $environment.Home ('plugin-packages/dsh-billing-ledger/' + $releaseInfo.package)
if (-not $PSCmdlet.ShouldProcess($environment.ProfileDir, "安装 dsh-billing-ledger $($releaseInfo.version)，DSH $runtime")) { return }
$backup = Backup-BillingProfile -Environment $environment -Operation 'install'
New-Item -ItemType Directory -Path (Split-Path $stablePackage) -Force | Out-Null
if (Test-Path -LiteralPath $stablePackage) {
    if ((Get-BillingFileHash -Path $stablePackage) -ine $actualHash) { throw "已有同版本安装包内容不同，请保留备份并检查：$stablePackage" }
} else { Copy-Item -LiteralPath $PackageFile -Destination $stablePackage }
$previousHome = $env:DSH_HOME
try {
    $env:DSH_HOME = $environment.Home
    & $environment.Cli plugin --profile $Profile add $stablePackage --ignore-scripts --config.auto-install-peers=false
    if ($LASTEXITCODE -ne 0) { throw "插件安装失败；profile 备份位于 $backup" }
    Set-BillingBundle -Manifest $environment.Manifest -Enabled $true
} finally { $env:DSH_HOME = $previousHome }
Write-Output "已安装 dsh-billing-ledger $($releaseInfo.version)。请正常退出并重新打开 DSH。"
Write-Output "配置备份：$backup"
Write-Output '原有会话和账本均保留；安装文件已保存到 DSH 用户目录，解压目录可自行留存。'
