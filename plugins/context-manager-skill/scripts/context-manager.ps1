# context-manager.ps1 - hook script for the context-manager plugin.
#
# Modes (first argument):
#   prompt                UserPromptSubmit: past prep_at, ask Claude to write a handoff; past compact_at, say it's time
#   precompact-auto       PreCompact (auto): hold auto-compaction until compact_at is reached AND the handoff is complete
#   precompact-manual     PreCompact (manual): if no handoff, block once; running /compact again within 2 min forces it
#   sessionstart-compact  SessionStart (compact): feed the handoff back in, then archive it
#   sessionstart-startup  SessionStart (startup): mention the latest handoff from an earlier session in this project
#
# Settings, highest priority first:
#   <project>/.claude/context-manager.json     project level (commit it to share with the repo)
#   ~/.claude/context-manager.json             universal, for all projects
#   plugin options (/plugin > Configure options), exported as CLAUDE_PLUGIN_OPTION_<KEY>
#   built-in defaults below

param([string]$Mode = 'prompt')

$ErrorActionPreference = 'Stop'
$Marker = '<!-- handoff-complete -->'
$ForceWindowSeconds = 120

# ---------- settings ----------

$Defaults = [ordered]@{
    enabled          = $true
    prep_at          = 130000
    compact_at       = 150000
    force_at         = 300000
    gate_manual      = $true
    offer_on_startup = $true
    handoff_dir      = '.claude/context-manager/handoffs'
}

function ConvertTo-Setting($name, $value) {
    if ($null -eq $value) { return $null }
    $template = $Defaults[$name]
    if ($template -is [bool]) {
        if ($value -is [bool]) { return $value }
        $s = "$value".Trim().ToLowerInvariant()
        if (@('true', '1', 'yes', 'on') -contains $s) { return $true }
        if (@('false', '0', 'no', 'off') -contains $s) { return $false }
        return $null
    }
    if ($template -is [int] -or $template -is [int64]) {
        $s = ("$value" -replace '[,_\s]', '').ToLowerInvariant()
        $mult = 1
        if ($s.EndsWith('k')) { $mult = 1000; $s = $s.TrimEnd('k') }
        elseif ($s.EndsWith('m')) { $mult = 1000000; $s = $s.TrimEnd('m') }
        $d = [double]0
        if ([double]::TryParse($s, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$d)) {
            return [int64]([Math]::Round($d * $mult))
        }
        return $null
    }
    return "$value"
}

function Read-JsonFile([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try { return ([IO.File]::ReadAllText($path) | ConvertFrom-Json) } catch {
        [Console]::Error.WriteLine("context-manager-skill: ignoring unreadable settings file $path")
        return $null
    }
}

function Get-Settings([string]$projectDir) {
    $s = [ordered]@{}
    $src = @{}
    foreach ($k in $Defaults.Keys) { $s[$k] = $Defaults[$k]; $src[$k] = 'default' }

    foreach ($k in @($Defaults.Keys)) {
        $v = ConvertTo-Setting $k ([Environment]::GetEnvironmentVariable('CLAUDE_PLUGIN_OPTION_' + $k.ToUpperInvariant()))
        if ($null -ne $v) { $s[$k] = $v; $src[$k] = 'plugin options' }
    }

    $homeDir = $env:USERPROFILE
    if (-not $homeDir) { $homeDir = $HOME }
    $layers = @(
        @{ path = (Join-Path (Join-Path $homeDir '.claude') 'context-manager.json'); name = 'user file' },
        @{ path = (Join-Path (Join-Path $projectDir '.claude') 'context-manager.json'); name = 'project file' }
    )
    foreach ($layer in $layers) {
        $obj = Read-JsonFile $layer.path
        if ($null -eq $obj) { continue }
        foreach ($p in $obj.PSObject.Properties) {
            if (-not $Defaults.Contains($p.Name)) { continue }
            $v = ConvertTo-Setting $p.Name $p.Value
            if ($null -ne $v) { $s[$p.Name] = $v; $src[$p.Name] = $layer.name }
        }
    }
    $s['_src'] = $src
    return $s
}

# ---------- helpers ----------

function Write-Json($obj) { [Console]::Out.Write(($obj | ConvertTo-Json -Depth 6 -Compress)) }
function Format-K([int64]$n) { return ('{0}k' -f [Math]::Round($n / 1000)) }

function Get-HandoffDir([string]$projectDir, $settings) {
    $d = $settings.handoff_dir
    if (-not [IO.Path]::IsPathRooted($d)) { $d = Join-Path $projectDir $d }
    return $d
}

function Initialize-HandoffDir([string]$dir) {
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $gi = Join-Path $dir '.gitignore'
    if (-not (Test-Path -LiteralPath $gi)) { [IO.File]::WriteAllText($gi, "*`n") }
}

function Test-HandoffComplete([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    return ([IO.File]::ReadAllText($path)).Contains($Marker)
}

# Context size = input + cache-write + cache-read tokens of the latest main-thread
# assistant message. 0 right after a compaction boundary, $null if unreadable.
function Get-ContextTokens([string]$path) {
    if (-not $path -or -not (Test-Path -LiteralPath $path)) { return $null }
    foreach ($tail in @(2MB, 24MB)) {
        $fs = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            $len = $fs.Length
            $start = [Math]::Max([int64]0, $len - $tail)
            [void]$fs.Seek($start, [IO.SeekOrigin]::Begin)
            $buf = New-Object byte[] ([int]($len - $start))
            $read = 0
            while ($read -lt $buf.Length) {
                $n = $fs.Read($buf, $read, $buf.Length - $read)
                if ($n -le 0) { break }
                $read += $n
            }
        } finally { $fs.Dispose() }

        $lines = [Text.Encoding]::UTF8.GetString($buf, 0, $read) -split "`n"
        for ($i = $lines.Count - 1; $i -ge 0; $i--) {
            $l = $lines[$i]
            if ($l.Contains('"compact_boundary"')) { return 0 }
            if (-not $l.Contains('"type":"assistant"')) { continue }
            if ($l.Contains('"isSidechain":true')) { continue }
            $m1 = [regex]::Match($l, '"input_tokens":(\d+)')
            if (-not $m1.Success) { continue }
            $m2 = [regex]::Match($l, '"cache_creation_input_tokens":(\d+)')
            $m3 = [regex]::Match($l, '"cache_read_input_tokens":(\d+)')
            $total = [int64]$m1.Groups[1].Value
            if ($m2.Success) { $total += [int64]$m2.Groups[1].Value }
            if ($m3.Success) { $total += [int64]$m3.Groups[1].Value }
            return $total
        }
        if ($start -eq 0) { break }
    }
    return $null
}

function Block([string]$reason) { Write-Json @{ decision = 'block'; reason = $reason }; exit 0 }

# ---------- main ----------

try {
    $raw = [Console]::In.ReadToEnd()
    if (-not $raw) { exit 0 }
    $hookInput = $raw | ConvertFrom-Json

    $projectDir = $env:CLAUDE_PROJECT_DIR
    if (-not $projectDir) { $projectDir = $hookInput.cwd }
    $cfg = Get-Settings $projectDir
    if (-not $cfg.enabled) { exit 0 }

    $handoffDir = Get-HandoffDir $projectDir $cfg
    $handoff = Join-Path $handoffDir ("handoff-" + $hookInput.session_id + ".md")

    switch ($Mode) {

        'prompt' {
            $ctx = Get-ContextTokens $hookInput.transcript_path
            if ($null -eq $ctx -or $ctx -lt $cfg.prep_at) { exit 0 }

            if (-not (Test-HandoffComplete $handoff)) {
                Initialize-HandoffDir $handoffDir
                $note = "Context-manager status: this session's context is about $(Format-K $ctx) tokens, past the user's " +
                        "$(Format-K $cfg.prep_at) preparation threshold (compaction at $(Format-K $cfg.compact_at)). " +
                        "Per the user's context-manager workflow, the compaction handoff for this session has not been written yet. " +
                        "Its path is $handoff. Compaction is held until that file ends with the line $Marker. " +
                        "The user's workflow is to run the context-manager-skill:prep-compact skill first, confirm in one line that the " +
                        "handoff is ready, then carry on with the request."
                Write-Json @{
                    systemMessage      = "Context at ~$(Format-K $ctx). Claude will save a handoff before compacting."
                    hookSpecificOutput = @{ hookEventName = 'UserPromptSubmit'; additionalContext = $note }
                }
                exit 0
            }

            if ($ctx -ge $cfg.compact_at) {
                $note = "Context-manager status: context is about $(Format-K $ctx) tokens and the handoff at $handoff is complete, " +
                        "so this session is ready to compact."
                Write-Json @{
                    systemMessage      = "Handoff ready, context at ~$(Format-K $ctx). Type /compact if auto-compact hasn't run."
                    hookSpecificOutput = @{ hookEventName = 'UserPromptSubmit'; additionalContext = $note }
                }
                exit 0
            }

            $note = "Context-manager status: context is about $(Format-K $ctx) tokens. The handoff at $handoff is complete; " +
                    "decisions made before compaction at $(Format-K $cfg.compact_at) belong in it too."
            Write-Json @{ hookSpecificOutput = @{ hookEventName = 'UserPromptSubmit'; additionalContext = $note } }
            exit 0
        }

        'precompact-auto' {
            $ctx = Get-ContextTokens $hookInput.transcript_path
            if ($null -ne $ctx -and $ctx -ge $cfg.force_at) {
                Write-Json @{ systemMessage = "Context at ~$(Format-K $ctx), past the $(Format-K $cfg.force_at) safety limit. Compacting." }
                exit 0
            }
            if ($null -ne $ctx -and $ctx -lt $cfg.compact_at) {
                Block "Context-manager: holding auto-compaction until ~$(Format-K $cfg.compact_at) (set in $($cfg._src['compact_at']))."
            }
            if (Test-HandoffComplete $handoff) {
                Write-Json @{ systemMessage = 'Handoff found. Compacting.' }
                exit 0
            }
            Block 'Context-manager: auto-compaction held until Claude saves a handoff (it will on the next turn).'
        }

        'precompact-manual' {
            if ((-not $cfg.gate_manual) -or (Test-HandoffComplete $handoff)) { exit 0 }
            $flag = Join-Path $handoffDir (".force-" + $hookInput.session_id)
            if ([IO.File]::Exists($flag)) {
                $age = ((Get-Date) - [IO.File]::GetLastWriteTime($flag)).TotalSeconds
                [IO.File]::Delete($flag)
                if ($age -le $ForceWindowSeconds) {
                    Write-Json @{ systemMessage = 'Compacting without a handoff, as requested.' }
                    exit 0
                }
            }
            Initialize-HandoffDir $handoffDir
            [IO.File]::WriteAllText($flag, (Get-Date -Format o))
            Block ("Context-manager: no handoff saved yet. Ask Claude to run /context-manager-skill:prep-compact first, " +
                   "or run /compact again within 2 minutes to compact anyway.")
        }

        'sessionstart-compact' {
            if (-not (Test-Path -LiteralPath $handoff)) { exit 0 }
            $text = [IO.File]::ReadAllText($handoff)
            $max = 9000
            if ($text.Length -gt $max) { $text = $text.Substring(0, $max) + "`n[...truncated; full handoff in the archived file]" }
            $archived = Join-Path $handoffDir ("handoff-" + $hookInput.session_id + ".used-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".md")
            Move-Item -LiteralPath $handoff -Destination $archived -Force
            [Console]::Out.Write("This session was just compacted. Before compaction, Claude saved this handoff " +
                                 "(archived at $archived):`n`n" + $text)
            exit 0
        }

        'sessionstart-startup' {
            if (-not $cfg.offer_on_startup -or -not (Test-Path -LiteralPath $handoffDir)) { exit 0 }
            $latest = Get-ChildItem -LiteralPath $handoffDir -Filter 'handoff-*.md' -File |
                      Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($null -eq $latest) { exit 0 }
            if (((Get-Date) - $latest.LastWriteTime).TotalDays -gt 14) { exit 0 }
            [Console]::Out.Write("Context-manager: the most recent compaction handoff in this project is $($latest.FullName), " +
                                 "saved $($latest.LastWriteTime.ToString('yyyy-MM-dd HH:mm')). It records where earlier work " +
                                 "left off and is worth reading if the user wants to continue that work.")
            exit 0
        }

        default { exit 0 }
    }
} catch {
    # Never break a session over a context-manager failure: stderr goes to the debug log and the action proceeds.
    [Console]::Error.WriteLine("context-manager ($Mode): " + $_.Exception.Message)
    exit 1
}
