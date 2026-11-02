#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    & npm test
    if ($LASTEXITCODE -ne 0) { throw '测试失败。' }
    & npm run check
    if ($LASTEXITCODE -ne 0) { throw '语法检查失败。' }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw '构建失败。' }
    & node --check lib/client.js
    if ($LASTEXITCODE -ne 0) { throw '前端语法检查失败。' }
    $manifest = Get-Content package.json -Raw | ConvertFrom-Json
    $dist = Join-Path $projectRoot 'dist'
    New-Item -ItemType Directory -Path $dist -Force | Out-Null
    $pack = & npm pack --json --pack-destination $dist
    if ($LASTEXITCODE -ne 0) { throw '打包失败。' }
    $archive = ($pack | Out-String | ConvertFrom-Json)[0].filename
    $packagePath = Join-Path $dist $archive
    $hash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $stage = Join-Path $dist ('windows-' + $manifest.version + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
    New-Item -ItemType Directory -Path $stage | Out-Null
    Copy-Item -LiteralPath $packagePath,README.md,LICENSE -Destination $stage
    foreach ($name in @('install.ps1','uninstall.ps1','common.ps1')) {
        $text = [IO.File]::ReadAllText((Join-Path $PSScriptRoot $name)).Replace("`r`n","`n").Replace("`n","`r`n")
        [IO.File]::WriteAllText((Join-Path $stage $name),$text,[Text.UTF8Encoding]::new($true))
    }
    $info = [ordered]@{version=$manifest.version;package=$archive;sha256=$hash;supportedDsh=@('0.2.1-rc.3','0.2.1-rc.5')}
    [IO.File]::WriteAllText((Join-Path $stage 'release.json'),($info|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    $zipName = 'dsh-billing-ledger-' + $manifest.version + '-windows.zip'
    $zipPath = Join-Path $dist $zipName
    Compress-Archive -LiteralPath @(Get-ChildItem -LiteralPath $stage -File | ForEach-Object FullName) -DestinationPath $zipPath -Force
    $zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $dist 'SHA256SUMS.txt'),"$zipHash  $zipName`n$hash  $archive`n",[Text.UTF8Encoding]::new($false))
    Write-Output "发布包：$zipPath"
    Write-Output "SHA-256：$zipHash"
} finally { Pop-Location }
