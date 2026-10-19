# update-and-enable-autoupdate.ps1
# Claude Context Manager Skill: update to the latest version and turn on auto-update.
#
# Run it (Windows): right-click the file > Run with PowerShell
#   or: powershell -NoProfile -ExecutionPolicy Bypass -File .\update-and-enable-autoupdate.ps1
# Also runs on macOS/Linux with PowerShell 7: pwsh ./update-and-enable-autoupdate.ps1
#
# What it does, on this computer only:
#   1. Refreshes the llnet-inc-tools marketplace and updates the plugin (installs it if missing)
#   2. Sets "autoUpdate": true for llnet-inc-tools in your Claude Code user settings (backup kept)
#   3. Offers to remove the old "context-guard" test plugin if it is still installed
# The terminal, the desktop app's Code tab and the IDE extensions share these settings.

$ErrorActionPreference = 'Stop'
try { Remove-TypeData System.Array -ErrorAction Stop } catch { }   # PowerShell 5.1 JSON array quirk

$Marketplace = 'llnet-inc-tools'
$Repo        = 'llnet-inc-tools/claude-context-manager-skill'
$Plugin      = "context-manager-skill@$Marketplace"

function Step([string]$text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Ok([string]$text)   { Write-Host "   $text" -ForegroundColor Green }
function Note([string]$text) { Write-Host "   $text" -ForegroundColor Yellow }

function Invoke-Claude([string[]]$arguments) {
    $out = & claude @arguments 2>&1 | Out-String
    return @{ code = $LASTEXITCODE; text = $out.Trim() }
}

function Pause-IfDoubleClicked {
    if ($Host.Name -eq 'ConsoleHost' -and [Environment]::GetCommandLineArgs() -match '-File') {
        Write-Host ''; Read-Host 'Press Enter to close' | Out-Null
    }
}

try {
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        throw "The 'claude' command wasn't found. Install Claude Code (https://code.claude.com) or open a new terminal, then run this again."
    }

    # 1. Marketplace and plugin
    Step 'Refreshing the marketplace'
    $known = Invoke-Claude @('plugin', 'marketplace', 'list')
    if ($known.text -notmatch [regex]::Escape($Marketplace)) {
        $r = Invoke-Claude @('plugin', 'marketplace', 'add', $Repo)
        if ($r.code -ne 0) { throw "Couldn't add the marketplace:`n$($r.text)" }
        Ok "Added $Marketplace"
    } else {
        $r = Invoke-Claude @('plugin', 'marketplace', 'update', $Marketplace)
        if ($r.code -ne 0) { throw "Couldn't refresh the marketplace:`n$($r.text)" }
        Ok "Refreshed $Marketplace"
    }

    Step 'Updating Claude Context Manager Skill'
    $list = Invoke-Claude @('plugin', 'list')
    if ($list.text -notmatch [regex]::Escape($Plugin)) {
        $r = Invoke-Claude @('plugin', 'install', $Plugin, '--scope', 'user')
        if ($r.code -ne 0) { throw "Couldn't install the plugin:`n$($r.text)" }
        Ok 'Installed (user scope: every project on this computer)'
    } else {
        $r = Invoke-Claude @('plugin', 'update', $Plugin)
        if ($r.code -ne 0) { throw "Couldn't update the plugin:`n$($r.text)" }
        Ok ($r.text -split "`n" | Select-Object -Last 1)
    }

    # 2. Auto-update in user settings
    Step 'Turning on auto-update'
    $configDir = $env:CLAUDE_CONFIG_DIR
    if (-not $configDir) {
        $homeDir = $env:USERPROFILE
        if (-not $homeDir) { $homeDir = $HOME }
        $configDir = Join-Path $homeDir '.claude'
    }
    $settingsPath = Join-Path $configDir 'settings.json'
    $settings = New-Object PSObject
    if (Test-Path -LiteralPath $settingsPath) {
        $raw = [IO.File]::ReadAllText($settingsPath)
        if ($raw.Trim()) {
            try { $settings = $raw | ConvertFrom-Json } catch { throw "$settingsPath isn't valid JSON, so it was left untouched. Fix it, then run this again." }
        }
        $backup = "$settingsPath.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
        Copy-Item -LiteralPath $settingsPath -Destination $backup
        Ok "Backed up settings to $backup"
    }
    if (-not ($settings.PSObject.Properties.Name -contains 'extraKnownMarketplaces')) {
        $settings | Add-Member -NotePropertyName extraKnownMarketplaces -NotePropertyValue (New-Object PSObject)
    }
    $markets = $settings.extraKnownMarketplaces
    if (-not ($markets.PSObject.Properties.Name -contains $Marketplace)) {
        $entry = [pscustomobject]@{ source = [pscustomobject]@{ source = 'github'; repo = $Repo } }
        $markets | Add-Member -NotePropertyName $Marketplace -NotePropertyValue $entry
    }
    $entry = $markets.$Marketplace
    if ($entry.PSObject.Properties.Name -contains 'autoUpdate') { $entry.autoUpdate = $true }
    else { $entry | Add-Member -NotePropertyName autoUpdate -NotePropertyValue $true }
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    [IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 64), (New-Object Text.UTF8Encoding $false))
    Ok "Auto-update is on for $Marketplace ($settingsPath)"

    # 3. Leftover test plugin
    $list = Invoke-Claude @('plugin', 'list')
    if ($list.text -match 'context-guard@llnet-tools') {
        Step 'Old test plugin found'
        Note "'context-guard@llnet-tools' (the first zip version) is still installed and would run alongside this one."
        $answer = Read-Host '   Remove it? [Y/n]'
        if ($answer -eq '' -or $answer -match '^[Yy]') {
            $r = Invoke-Claude @('plugin', 'uninstall', 'context-guard@llnet-tools')
            if ($r.code -eq 0) { Ok 'Removed context-guard' } else { Note "Couldn't remove it: $($r.text)" }
        }
    }

    Step 'Done'
    $list = Invoke-Claude @('plugin', 'list')
    $block = ($list.text -split "(?m)^\s*$") | Where-Object { $_ -match [regex]::Escape($Plugin) } | Select-Object -First 1
    if ($block) { Write-Host $block.TrimEnd() }
    Write-Host ''
    Write-Host '   Fully quit the Claude app (including from the system tray) and reopen it,' -ForegroundColor Green
    Write-Host '   then run /context-manager in a new Code-tab session to check the version.' -ForegroundColor Green
} catch {
    Write-Host ''
    Write-Host "   $($_.Exception.Message)" -ForegroundColor Red
    Pause-IfDoubleClicked
    exit 1
}
Pause-IfDoubleClicked
