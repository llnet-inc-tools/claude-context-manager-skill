# set-autocompact.ps1 - sets the point where Claude Code attempts auto-compaction.
# This is a Windows user environment variable, so it applies to every project.
# context-manager then decides per project whether to let that compaction run.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File set-autocompact.ps1 -Tokens 150000
#   powershell -NoProfile -ExecutionPolicy Bypass -File set-autocompact.ps1 -Clear
#
# Set -Tokens to the LOWEST compact_at you use in any project. A model with a 200k
# window reads the same percentage, so 15% means ~30k there.

param(
    [int64]$Tokens = 150000,
    [int64]$WindowTokens = 1000000,
    [switch]$Clear
)

$name = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'
$old = [Environment]::GetEnvironmentVariable($name, 'User')

if ($Clear) {
    [Environment]::SetEnvironmentVariable($name, $null, 'User')
    Write-Output "Cleared $name (was: $old). Auto-compaction is back to Claude Code's default."
} else {
    $pct = [int][Math]::Ceiling($Tokens * 100.0 / $WindowTokens)
    if ($pct -lt 1 -or $pct -gt 100) { throw "That works out to $pct%, which is outside 1-100." }
    [Environment]::SetEnvironmentVariable($name, "$pct", 'User')
    Write-Output "Set $name=$pct (~$Tokens tokens on a $WindowTokens-token window). Previous value: $old"
}
Write-Output 'Fully quit the Claude app (including from the system tray) and reopen it for this to take effect.'
