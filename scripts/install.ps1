# Native Windows source install. Re-run to update an existing checkout.
$ErrorActionPreference = 'Stop'
function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed (exit $LASTEXITCODE)" }
}
foreach ($name in @('git', 'node', 'npm.cmd')) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "$name is required. Install Git for Windows and Node.js >= 22.5, then reopen PowerShell." }
}
Invoke-Checked node @('-e', 'const [M,m]=process.versions.node.split(".").map(Number);process.exit(M>22||(M===22&&m>=5)?0:1)')
$loomRepo = if ($env:LOOM_REPO) { $env:LOOM_REPO } else { 'https://github.com/nickthelegend/loom.git' }
$loomSource = if ($env:LOOM_SRC) { $env:LOOM_SRC } else { Join-Path $env:USERPROFILE '.loom-src' }
if (Test-Path -LiteralPath (Join-Path $loomSource '.git')) {
    Invoke-Checked git @('-C', $loomSource, 'pull', '--ff-only')
} else {
    Invoke-Checked git @('clone', '--depth', '1', $loomRepo, $loomSource)
}
Push-Location -LiteralPath $loomSource
try {
    Invoke-Checked npm.cmd @('ci', '--no-fund', '--no-audit')
    Invoke-Checked npm.cmd @('link', '--no-fund', '--no-audit')
    Invoke-Checked node @('dist/cli/index.js', '--version')
} finally { Pop-Location }
Write-Host "Installed Loom in $loomSource. In your project, run: loom.cmd init"
Write-Host 'Start Loom with loom.cmd. PowerShell can also use loom when its execution policy permits npm scripts.'
if ($args.Count -gt 0) { Invoke-Checked loom.cmd $args }
