param(
    [string]$Release = '0.3.0-rc.2-20261003',
    [string]$ProjectRoot = '',
    [string]$AppRoot = (Join-Path $env:USERPROFILE '.agent-apps/video-transcript'),
    [switch]$Publish,
    [string]$AcceptanceFile = '',
    [string]$StateRoot = (Join-Path $env:USERPROFILE '.agent-apps/video-transcript/private')
)
$ErrorActionPreference = 'Stop'
if ($Release -notmatch '^[a-zA-Z0-9.-]+$') { throw '无效发布版本' }
$taskSource = Split-Path -Parent $PSScriptRoot
$taskReleasePath = Join-Path $AppRoot "releases/$Release"
if (Test-Path -LiteralPath $taskReleasePath) { throw "发布目录已存在，使用新的版本号：$taskReleasePath" }
$taskNode = (Get-Command node -ErrorAction Stop).Source
if ($Publish) {
    if ($Release -match '-rc\.') { throw '候选版本不能作为正式入口发布，请显式指定正式发布目录版本' }
    if (-not $AcceptanceFile) { throw '正式发布必须提供真实平台验收清单 -AcceptanceFile' }
    & $taskNode (Join-Path $PSScriptRoot 'check-release.js') $AcceptanceFile $StateRoot
    if ($LASTEXITCODE -ne 0) { throw 'B站、抖音、小红书各三例真实取稿及覆盖验收未通过，未修改任何正式入口' }
    $taskVersion = (Get-Content -LiteralPath (Join-Path $taskSource 'package.json') -Raw | ConvertFrom-Json).version
    if ($taskVersion -ne '0.3.0') { throw '验收通过后先将源码版本提升为0.3.0，再正式发布' }
}
New-Item -ItemType Directory -Path $taskReleasePath -Force | Out-Null
foreach ($taskName in @('SKILL.md', 'package.json', 'package-lock.json', 'scripts', 'references', 'tests')) {
    Copy-Item -LiteralPath (Join-Path $taskSource $taskName) -Destination $taskReleasePath -Recurse
}
Push-Location $taskReleasePath
try {
    & npm.cmd ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw '依赖安装失败；尚未登记技能入口' }
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw '回归测试未通过；尚未登记技能入口' }
    & $taskNode 'scripts/cli.js' doctor --state-root $StateRoot
    if ($LASTEXITCODE -ne 0) { throw 'doctor 未通过；尚未登记技能入口' }
} finally { Pop-Location }
if (-not $Publish) {
    @{ staged = $true; published = $false; release = $taskReleasePath; cli = (Join-Path $taskReleasePath 'scripts/cli.js') } | ConvertTo-Json -Compress
    return
}
& $taskNode (Join-Path $taskReleasePath 'scripts/check-release.js') $AcceptanceFile $StateRoot
if ($LASTEXITCODE -ne 0) { throw '发布目录核验或真实产物摘要已变化，未修改任何正式入口' }
$taskSkillRoots = @(
    (Join-Path $env:USERPROFILE '.codex/skills'),
    (Join-Path $env:USERPROFILE '.agents/skills'),
    (Join-Path $env:USERPROFILE '.workbuddy/skills')
)
foreach ($taskSkillRoot in $taskSkillRoots) {
    $taskSkill = Join-Path $taskSkillRoot 'video-transcript'
    if (Test-Path -LiteralPath $taskSkill) {
        $taskExisting = Join-Path $taskSkill 'SKILL.md'
        if (-not (Test-Path -LiteralPath $taskExisting) -or -not ((Get-Content -LiteralPath $taskExisting -Raw).Contains('name: video-transcript'))) {
            throw "同名非本插件目录已存在：$taskSkill"
        }
    }
}
foreach ($taskSkillRoot in $taskSkillRoots) {
    $taskSkill = Join-Path $taskSkillRoot 'video-transcript'
    New-Item -ItemType Directory -Path (Join-Path $taskSkill 'scripts') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskSource 'SKILL.md') -Destination (Join-Path $taskSkill 'SKILL.md')
    Copy-Item -LiteralPath (Join-Path $taskSource 'references') -Destination $taskSkill -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'vtrans.ps1') -Destination (Join-Path $taskSkill 'scripts/vtrans.ps1')
    @{ node = $taskNode; cli = (Join-Path $taskReleasePath 'scripts/cli.js'); version = $Release } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskSkill 'scripts/runtime.json') -Encoding utf8
}
if ($ProjectRoot) {
    $taskConfigPath = Join-Path $AppRoot 'private/config.json'
    $taskConfig = @{}
    if (Test-Path -LiteralPath $taskConfigPath) {
        $taskOldConfig = Get-Content -LiteralPath $taskConfigPath -Raw | ConvertFrom-Json
        foreach ($taskProperty in $taskOldConfig.PSObject.Properties) { $taskConfig[$taskProperty.Name] = $taskProperty.Value }
    }
    $taskConfig['source_book'] = Join-Path $ProjectRoot '07_系统文档（Docs）/视频网站链接与听悟适配记录.md'
    New-Item -ItemType Directory -Path (Split-Path -Parent $taskConfigPath) -Force | Out-Null
    $taskConfig | ConvertTo-Json | Set-Content -LiteralPath $taskConfigPath -Encoding utf8
    & $taskNode (Join-Path $taskReleasePath 'scripts/cli.js') sources
    if ($LASTEXITCODE -ne 0) { throw '适配记录文档生成失败' }
    $taskProjectSkill = Join-Path $ProjectRoot '01_Skill能力库（Skills）/yushu_17_视频转写_VideoTranscript'
    $taskResolvedProject = [System.IO.Path]::GetFullPath($taskProjectSkill)
    $taskResolvedSource = [System.IO.Path]::GetFullPath($taskSource)
    if ($taskResolvedProject -ne $taskResolvedSource) {
        New-Item -ItemType Directory -Path $taskProjectSkill -Force | Out-Null
        foreach ($taskName in @('SKILL.md', 'package.json', 'package-lock.json', 'scripts', 'references', 'tests')) {
            Copy-Item -LiteralPath (Join-Path $taskSource $taskName) -Destination $taskProjectSkill -Recurse -Force
        }
        Push-Location $taskProjectSkill
        try {
            & npm.cmd ci --ignore-scripts --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw '项目技能依赖安装失败' }
        } finally { Pop-Location }
    }
}
@{ installed = $true; release = $taskReleasePath; skill_roots = $taskSkillRoots } | ConvertTo-Json -Compress
