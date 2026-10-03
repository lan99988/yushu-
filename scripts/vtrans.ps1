param([Parameter(ValueFromRemainingArguments=$true)][string[]]$VtransArguments)
$ErrorActionPreference = 'Stop'
$taskLocalCli = Join-Path $PSScriptRoot 'cli.js'
if (Test-Path -LiteralPath $taskLocalCli) {
    & node $taskLocalCli @VtransArguments
} else {
    $taskRuntime = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime.json') -Raw | ConvertFrom-Json
    & $taskRuntime.node $taskRuntime.cli @VtransArguments
}
exit $LASTEXITCODE
