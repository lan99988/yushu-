param(
    [string]$Destination = '',
    [switch]$Offline
)
$ErrorActionPreference = 'Stop'
$taskHome = [Environment]::GetFolderPath('UserProfile')
if (-not $taskHome) { $taskHome = $HOME }
if (-not $Destination) { $Destination = Join-Path $taskHome '.agents/skills/video-transcript-candidate' }
$taskDestination = [IO.Path]::GetFullPath($Destination)
if ((Split-Path -Leaf $taskDestination) -notmatch '^video-transcript-candidate(?:-[a-zA-Z0-9.-]+)?$') {
    throw '候选安装目录必须命名为 video-transcript-candidate 或 video-transcript-candidate-后缀；不能写入正式技能目录'
}
if (Test-Path -LiteralPath $taskDestination) { throw "候选目录已存在，保留原安装；请使用新候选目录：$taskDestination" }
$taskSource = Split-Path -Parent $PSScriptRoot
$taskPackage = Get-Content -LiteralPath (Join-Path $taskSource 'package.json') -Raw | ConvertFrom-Json
if ($taskPackage.version -notmatch '-rc\.') { throw '此安装器仅接受候选版本；不会切换正式入口' }
$taskNode = (Get-Command node -ErrorAction Stop).Source
$taskMajor = & $taskNode -p 'process.versions.node.split(".")[0]'
if ($LASTEXITCODE -ne 0 -or [int]$taskMajor -lt 20) { throw '需要 Node.js >=20（建议 >=22）及 npm，安装后重新打开终端' }
$taskNpmName = if ($env:OS -eq 'Windows_NT') { 'npm.cmd' } else { 'npm' }
$taskNpm = (Get-Command $taskNpmName -ErrorAction Stop).Source
$taskStage = $taskDestination + '.install-' + [guid]::NewGuid().ToString('N')
New-Item -ItemType Directory -Path $taskStage -Force | Out-Null
# 白名单复制；不带走 node_modules、runtime.json、Cookie、profile、任务或本机配置。
foreach ($taskName in @('SKILL.md', 'package.json', 'package-lock.json', 'scripts', 'references', 'tests')) {
    Copy-Item -LiteralPath (Join-Path $taskSource $taskName) -Destination $taskStage -Recurse
}
if (Test-Path -LiteralPath (Join-Path $taskStage 'scripts/runtime.json')) {
    Remove-Item -LiteralPath (Join-Path $taskStage 'scripts/runtime.json')
}
$taskSkillPath = Join-Path $taskStage 'SKILL.md'
$taskSkill = Get-Content -LiteralPath $taskSkillPath -Raw
$taskSkill = $taskSkill -replace '(?m)^name: video-transcript\s*$', 'name: video-transcript-candidate'
$taskSkill = $taskSkill.Replace('scripts/vtrans.ps1', 'scripts/vtrans-candidate.ps1')
$taskSkill = $taskSkill.Replace('# 视频转写插件', "# 视频转写候选插件`n`n独立候选入口；不会更改正式技能。私有状态默认位于 ~/.agent-apps/video-transcript-candidate/private；自定义使用 VTRANS_CANDIDATE_HOME 或 --state-root，不能直接运行 cli.js 代替候选启动器。安装及依赖见 [便携安装](references/portable-install.md)。")
Set-Content -LiteralPath $taskSkillPath -Value $taskSkill -Encoding utf8
Push-Location $taskStage
try {
    $taskNpmArguments = @('ci', '--ignore-scripts', '--no-audit', '--no-fund')
    if ($Offline) { $taskNpmArguments += '--offline' }
    & $taskNpm @taskNpmArguments
    if ($LASTEXITCODE -ne 0) { throw "依赖安装失败，未登记候选入口；诊断目录：$taskStage" }
    & $taskNpm test
    if ($LASTEXITCODE -ne 0) { throw "回归测试失败，未登记候选入口；诊断目录：$taskStage" }
} finally { Pop-Location }
if (Test-Path -LiteralPath $taskDestination) { throw "目标目录在安装期间已出现，保留原目录；候选暂存在：$taskStage" }
Move-Item -LiteralPath $taskStage -Destination $taskDestination
# 仅离线依赖检查，不打开页面、不导入本机登录态。doctor 的失败不会伪装成运行就绪。
$taskDoctorText = & $taskNode (Join-Path $taskDestination 'scripts/cli.js') doctor --state-root (
    $(if ($env:VTRANS_CANDIDATE_HOME) { $env:VTRANS_CANDIDATE_HOME } else { Join-Path $taskHome '.agent-apps/video-transcript-candidate/private' })
)
$taskDoctorCode = $LASTEXITCODE
$taskDoctor = $taskDoctorText | ConvertFrom-Json
$taskDetails = if ($taskDoctor.ok) { $taskDoctor.data } else { $taskDoctor.error.details }
$taskMissing = @()
if ($taskDetails.version) {
    if (-not $taskDetails.playwright) { $taskMissing += 'playwright-core' }
    if (-not $taskDetails.browser) { $taskMissing += 'Chrome/Edge 或 VTRANS_CHROME' }
    if (-not $taskDetails.ffmpeg) { $taskMissing += 'ffmpeg' }
    if (-not $taskDetails.ffprobe) { $taskMissing += 'ffprobe' }
}
@{ installed = $true; published = $false; candidate = $true; version = $taskPackage.version;
   skill = $taskDestination; cli = (Join-Path $taskDestination 'scripts/vtrans-candidate.ps1');
   doctor_ok = ($taskDoctorCode -eq 0 -and $taskDoctor.ok); media_ready = ($taskDoctor.ok -and $taskMissing.Count -eq 0);
   doctor_error = $(if (-not $taskDoctor.ok) { $taskDoctor.error } else { $null });
   missing_dependencies = $taskMissing; yt_dlp_available = [bool]$taskDetails.yt_dlp;
   login_verified = $false; online_verified = $false;
   next = '补齐依赖后运行候选入口 doctor；然后人工 login，按来源需要 media-login；安装完成不表示平台或取稿验收通过'
} | ConvertTo-Json -Depth 5 -Compress
