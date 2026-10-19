// Claude Context Manager Skill: the hooks module.
//
// Runs inside Claude Code itself, so it behaves the same on Windows, macOS and
// Linux, in the terminal, the desktop app and the IDE extensions.
//
//   prompt.submit    past prep_at, asks Claude for a handoff; after a compaction, restores it
//   session.compact  holds compaction until compact_at and a finished handoff (force_at overrides)
//   turn.complete    compacts on its own once the handoff is saved and compact_at is reached
//   session.start    registers /context-manager and points new sessions at the latest handoff
//   ui.render        draws the context meter above the prompt

import type { EngineInterface, Register } from 'claude-code'

import {
  type HandoffState,
  type Resolved,
  type Settings,
  SETTINGS_FILE,
  STARTUP_MAX_AGE_MS,
  archiveName,
  formatK,
  formatValue,
  gateCompaction,
  handoffDir,
  handoffFile,
  handoffState,
  joinPath,
  KEYS,
  meterText,
  parseJsonFile,
  phaseOf,
  prepNote,
  readyNote,
  resolveSettings,
  restoreNote,
  startupNote,
} from './core'

type $ = EngineInterface
type Loaded = Resolved & { root: string; userPath?: string; projectPath: string }

const COMMAND = 'context-manager'
const restoreKey = (sid: string) => `restore:${sid}`

async function readText($: $, path: string): Promise<string | undefined> {
  try {
    if (!(await $.fs.exists(path))) return undefined
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

async function claudeDir($: $): Promise<string | undefined> {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configured) return configured
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home ? joinPath(home, '.claude') : undefined
}

async function load($: $, options: Readonly<Record<string, unknown>>): Promise<Loaded> {
  const root = await $.session.root()
  const dir = await claudeDir($)
  const userPath = dir ? joinPath(dir, SETTINGS_FILE) : undefined
  const projectPath = joinPath(root, '.claude', SETTINGS_FILE)
  const user = userPath ? parseJsonFile((await readText($, userPath)) ?? '', 'the user settings file') : {}
  const project = parseJsonFile((await readText($, projectPath)) ?? '', 'the project settings file')
  const resolved = resolveSettings({ options, user: user.value, project: project.value })
  for (const p of [user.problem, project.problem]) if (p) resolved.problems.push(p)
  return { ...resolved, root, userPath, projectPath }
}

async function ensureHandoffDir($: $, dir: string): Promise<void> {
  const ignore = joinPath(dir, '.gitignore')
  if (!(await $.fs.exists(ignore))) await $.fs.write(ignore, '*\n')
}

// Module state: starts over on a reload, which is harmless for each of these.
const mem = {
  pendingStartup: undefined as string | undefined,
  lastManualBlockAt: undefined as number | undefined,
  isCompactScheduled: false,
  isJustCompacted: false,
}

// After a compaction: archive the handoff and queue it for the next prompt. Idempotent.
async function afterCompaction($: $, s: Settings, root: string, sid: string): Promise<void> {
  const path = handoffFile(root, s, sid)
  const text = await readText($, path)
  if (handoffState(text) !== 'complete' || text === undefined) return
  const archived = joinPath(handoffDir(root, s), archiveName(sid, new Date(await $.clock.now())))
  await $.fs.write(archived, text)
  await $.fs.write(path, '')
  await $.store.set(restoreKey(sid), restoreNote(archived, text))
}

async function snapshot($: $, options: Readonly<Record<string, unknown>>) {
  const st = await load($, options)
  const sid = await $.session.id()
  const { context } = await $.session.usage()
  const path = handoffFile(st.root, st.values, sid)
  const handoff: HandoffState = handoffState(await readText($, path))
  const tokens = mem.isJustCompacted ? undefined : context.tokens
  return { st, s: st.values, sid, path, state: handoff, tokens, window: context.window }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      await $.command.register({
        name: COMMAND,
        description: 'Claude Context Manager Skill: show context size, handoff state and settings',
      })
      const st = await load($, options)
      const s = st.values
      if (s.enabled && s.offer_on_startup) {
        const dir = handoffDir(st.root, s)
        const sid = await $.session.id()
        if (await $.fs.exists(dir)) {
          const now = await $.clock.now()
          const newest = (await $.fs.list(dir))
            .filter(f => f.kind === 'file' && f.size > 0 && /^handoff-.+\.md$/.test(f.name) && !f.name.startsWith(`handoff-${sid}`))
            .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
          if (newest && now - newest.mtimeMs <= STARTUP_MAX_AGE_MS) {
            mem.pendingStartup = startupNote(joinPath(dir, newest.name), new Date(newest.mtimeMs).toISOString().slice(0, 16).replace('T', ' '))
          }
        }
      }
    } catch (err) {
      $.ui.log(`session.start: ${String(err)}`)
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    const extra: string[] = []
    try {
      const snap = await snapshot($, options)
      const { s, sid, path, state, tokens } = snap
      if (s.enabled) {
        const restore = await $.store.get(restoreKey(sid))
        if (typeof restore === 'string') {
          extra.push(restore)
          await $.store.delete(restoreKey(sid))
        }
        if (mem.pendingStartup) {
          extra.push(mem.pendingStartup)
          mem.pendingStartup = undefined
        }
        if (tokens !== undefined && tokens >= s.prep_at && typeof restore !== 'string') {
          if (state !== 'complete') {
            await ensureHandoffDir($, handoffDir(snap.st.root, s))
            extra.push(prepNote(tokens, s, path))
            $.ui.toast(`Context at ~${formatK(tokens)}. Claude will save a handoff before compacting.`)
          } else {
            extra.push(readyNote(tokens, s, path))
            if (tokens >= s.compact_at && !s.auto_compact) $.ui.toast('Handoff saved. Type /compact when you are ready.')
          }
        }
      }
    } catch (err) {
      $.ui.log(`prompt.submit: ${String(err)}`)
    }
    $.ui.invalidate('ui.render')
    return extra.length > 0 ? next({ ...e, context: [...(e.context ?? []), ...extra] }) : next(e)
  }).catch(($, e, next) => next(e)) // never block a prompt

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    let snap: Awaited<ReturnType<typeof snapshot>>
    try {
      snap = await snapshot($, options)
    } catch (err) {
      $.ui.log(`session.compact: ${String(err)}; letting it run`)
      return next(e)
    }
    const { s, sid, path, state, tokens, st } = snap
    const now = await $.clock.now()
    const decision = gateCompaction({ trigger: e.trigger, tokens, state, s, now, lastManualBlockAt: mem.lastManualBlockAt })
    if (!decision.allow) {
      if (e.trigger === 'manual') mem.lastManualBlockAt = now
      if (e.trigger !== 'precompute') mem.isCompactScheduled = false
      return { skip: decision.reason }
    }
    if (e.trigger === 'manual') mem.lastManualBlockAt = undefined

    const instructions =
      s.enabled && state === 'complete'
        ? [e.instructions, `A detailed handoff (${path}) is given back to the conversation right after this compaction, so the summary can stay brief about file lists and next steps.`]
            .filter(Boolean)
            .join('\n\n')
        : e.instructions
    const result = await next(instructions === undefined ? e : { ...e, instructions })
    if (result.skip !== undefined || e.trigger === 'precompute') return result

    mem.isCompactScheduled = false
    mem.isJustCompacted = true
    try {
      if (s.enabled) await afterCompaction($, s, st.root, sid)
      if (decision.reason) $.ui.toast(decision.reason)
    } catch (err) {
      $.ui.log(`after compaction: ${String(err)}`)
    }
    $.ui.invalidate('ui.render')
    return result
  }).catch(($, e, next) => next(e)) // never block a compaction by failing

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    mem.isJustCompacted = false
    $.ui.invalidate('ui.render')
    if (e.isAborted || mem.isCompactScheduled) return result
    try {
      const { s, state, tokens, st, sid, path } = await snapshot($, options)
      if (s.enabled && s.auto_compact && tokens !== undefined && tokens >= s.compact_at && state === 'complete') {
        mem.isCompactScheduled = true
        $.clock.after(1500, () => {
          $.session
            .compact({ instructions: `A detailed handoff (${path}) is given back to the conversation right after this compaction.` })
            .then(async outcome => {
              mem.isCompactScheduled = false
              if (outcome.skip !== undefined) return
              // Our own hooks may be skipped for our own call, so finish the job here too (idempotent).
              mem.isJustCompacted = true
              await afterCompaction($, s, st.root, sid)
              $.ui.invalidate('ui.render')
            })
            .catch(() => {
              mem.isCompactScheduled = false // a turn started first; try again after the next one
            })
        })
      }
    } catch (err) {
      $.ui.log(`turn.complete: ${String(err)}`)
    }
    return result
  })

  on('command.run', { command: COMMAND }, async $ => {
    try {
      const { st, s, sid, path, state, tokens, window } = await snapshot($, options)
      let version = '?'
      try {
        const manifest = JSON.parse((await readText($, joinPath($.plugin.root, '.claude-plugin', 'plugin.json'))) ?? '{}')
        if (typeof manifest.version === 'string') version = manifest.version
      } catch {
        /* keep '?' */
      }
      const engine = (await $.session.version()).version
      const phase = phaseOf(tokens, state, s)
      const handoffLine =
        state === 'complete' ? `saved: ${path}` : state === 'started' ? `started, not finished: ${path}` : 'not written yet'
      const next =
        phase === 'below-prep' && tokens !== undefined
          ? `handoff at ${formatK(s.prep_at)} (${formatK(s.prep_at - tokens)} to go)`
          : phase === 'handoff-due'
            ? 'handoff due: Claude writes it on your next message'
            : phase === 'ready-below-compact'
              ? `handoff saved; compaction allowed from ${formatK(s.compact_at)}`
              : phase === 'ready-to-compact'
                ? s.auto_compact
                  ? 'compacting after the current turn'
                  : 'ready: type /compact'
                : 'waiting for the first reply'
      const width = Math.max(...KEYS.map(k => k.length))
      const lines = [
        `Claude Context Manager Skill v${version} (Claude Code ${engine})`,
        `  Status    ${s.enabled ? 'active in this session' : `off (enabled is false in the ${st.sources.enabled})`}`,
        `  Context   ${tokens === undefined ? 'waiting for the first reply' : `${formatK(tokens)} of ${formatK(window)} (${Math.round((tokens / window) * 100)}%)`}`,
        `  Next      ${next}`,
        `  Handoff   ${handoffLine}`,
        '',
        'Settings',
        ...KEYS.map(k => `  ${k.padEnd(width)}  ${formatValue(s[k]).padEnd(34)} ${st.sources[k]}`),
        '',
        `  Project file  ${st.projectPath}`,
        `  User file     ${st.userPath ?? '(home folder not found)'}`,
        ...(st.problems.length ? ['', 'Problems', ...st.problems.map(p => `  - ${p}`)] : []),
      ]
      return { text: lines.join('\n') }
    } catch (err) {
      return { text: `Claude Context Manager Skill could not read its status: ${String(err)}` }
    }
  }).catch(() => ({ text: 'Claude Context Manager Skill: the status command failed.' }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    let view: { text: string; color?: 'warning' | 'success' }
    try {
      const { s, state, tokens, window } = await snapshot($, options)
      if (!s.enabled || !s.show_meter) return next(e)
      const phase = phaseOf(tokens, state, s)
      view = {
        text: meterText(tokens, window, phase, s),
        color: phase === 'handoff-due' ? 'warning' : phase === 'ready-to-compact' ? 'success' : undefined,
      }
    } catch {
      return next(e)
    }
    const { Text } = $.ui.resolve(e)
    return view.color ? <Text color={view.color}>{view.text}</Text> : <Text dimColor>{view.text}</Text>
  })
}

