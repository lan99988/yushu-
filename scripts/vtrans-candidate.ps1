param([Parameter(ValueFromRemainingArguments=$true)][string[]]$VtransArguments)
$ErrorActionPreference = 'Stop'
$taskCli = Join-Path $PSScriptRoot 'cli.js'
if (-not (Test-Path -LiteralPath $taskCli -PathType Leaf)) { throw '候选安装不完整：本目录缺少 cli.js，请重新安装到新的候选目录' }
$taskNode = (Get-Command node -ErrorAction Stop).Source
if ($VtransArguments -notcontains '--state-root') {
    $taskHome = [Environment]::GetFolderPath('UserProfile')
    if (-not $taskHome) { $taskHome = $HOME }
    $taskState = $env:VTRANS_CANDIDATE_HOME
    if (-not $taskState) { $taskState = Join-Path $taskHome '.agent-apps/video-transcript-candidate/private' }
    $VtransArguments = @($VtransArguments) + @('--state-root', $taskState)
}
$taskOriginalBook = $env:VTRANS_SOURCE_BOOK
try {
    # 正式入口的适配记录路径不能污染候选任务。
    $env:VTRANS_SOURCE_BOOK = $env:VTRANS_CANDIDATE_SOURCE_BOOK
    & $taskNode $taskCli @VtransArguments
    $taskExitCode = $LASTEXITCODE
} finally { $env:VTRANS_SOURCE_BOOK = $taskOriginalBook }
exit $taskExitCode
