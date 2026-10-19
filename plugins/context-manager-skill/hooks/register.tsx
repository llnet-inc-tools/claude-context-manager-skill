// Claude Context Manager Skill: the hooks module.
//
// Runs inside Claude Code itself, so it behaves the same on Windows, macOS and
// Linux, in the terminal, the desktop app and the IDE extensions.
//
//   prompt.submit    past prep_at, asks Claude for a handoff; after a compaction, restores it
//   session.compact  holds compaction until compact_at and a finished handoff (force_at overrides)
//   turn.complete    compacts on its own at compact_at; runs options the user picked mid-turn
//   tool.call        serves the context_manager tool; adds a context budget when tasks are planned
//   session.start    registers /context-manager and the tool; points new sessions at the latest handoff
//   ui.render        draws the context meter and, when there is a choice to make, the options picker

import type { EngineInterface, Register } from 'claude-code'

import {
  ACTION_HELP,
  type ActionId,
  type HandoffState,
  type Offer,
  type OfferKind,
  type Resolved,
  type Settings,
  SETTINGS_FILE,
  STARTUP_MAX_AGE_MS,
  actionLabel,
  archiveName,
  buildOffer,
  continuePrompt,
  expandedSettings,
  formatK,
  formatValue,
  gateCompaction,
  handoffDir,
  handoffFile,
  handoffState,
  isActionId,
  isSituation,
  joinPath,
  KEYS,
  meterText,
  offerChoicesText,
  parseJsonFile,
  phaseOf,
  preflightNote,
  prepNote,
  readyNote,
  resolveSettings,
  restoreNote,
  snoozed,
  startupNote,
} from './core'

type $ = EngineInterface
type Opts = Readonly<Record<string, unknown>>
type Loaded = Resolved & { root: string; sid: string; userPath?: string; projectPath: string }

const COMMAND = 'context-manager'
const TOOL = 'context_manager'
const PLANNING_TOOLS = new Set(['TaskCreate', 'TodoWrite', 'ExitPlanMode'])
const restoreKey = (sid: string) => `restore:${sid}`
const sessionKey = (sid: string) => `session:${sid}`

const PREP_PROMPT =
  'Run the context-manager-skill:prep-compact skill now to save the compaction handoff for this session, then stop.'
const FINISH_PROMPT =
  'Finish the step you are on, update the compaction handoff (keep its last line as it is), then stop. The context manager compacts afterwards.'
const REVIEW_PROMPT =
  'Show me the compaction handoff as a short summary (goal, current status, next steps) and ask what I want to change in it.'
const GO_PROMPT = 'Go ahead with the planned tasks.'

// Module state: starts over on a reload, which is harmless for each of these.
const mem = {
  pendingStartup: undefined as string | undefined,
  lastManualBlockAt: undefined as number | undefined,
  isCompactScheduled: false,
  isJustCompacted: false,
  isTurnRunning: false,
  turnId: undefined as string | undefined,
  preflightTurnId: undefined as string | undefined,
  offer: undefined as Offer | undefined,
  pendingAction: undefined as ActionId | undefined, // picked mid-turn: runs when the turn ends
  afterHandoff: undefined as ActionId | undefined, // waits for a complete handoff first
  compactAfterFinish: false,
  isFinishTurn: false,
  pendingContinue: undefined as string | undefined, // the prompt a cleared session starts with
  toolName: undefined as string | undefined,
}

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

async function load($: $, options: Opts): Promise<Loaded> {
  const root = await $.session.root()
  const sid = await $.session.id()
  const dir = await claudeDir($)
  const userPath = dir ? joinPath(dir, SETTINGS_FILE) : undefined
  const projectPath = joinPath(root, '.claude', SETTINGS_FILE)
  const user = userPath ? parseJsonFile((await readText($, userPath)) ?? '', 'the user settings file') : {}
  const project = parseJsonFile((await readText($, projectPath)) ?? '', 'the project settings file')
  const session = await $.store.get(sessionKey(sid))
  const resolved = resolveSettings({ options, user: user.value, project: project.value, session })
  for (const p of [user.problem, project.problem]) if (p) resolved.problems.push(p)
  return { ...resolved, root, sid, userPath, projectPath }
}

async function ensureHandoffDir($: $, dir: string): Promise<void> {
  const ignore = joinPath(dir, '.gitignore')
  if (!(await $.fs.exists(ignore))) await $.fs.write(ignore, '*\n')
}

async function snapshot($: $, options: Opts) {
  const st = await load($, options)
  const { context } = await $.session.usage()
  const path = handoffFile(st.root, st.values, st.sid)
  const state: HandoffState = handoffState(await readText($, path))
  const tokens = mem.isJustCompacted ? undefined : context.tokens
  return { st, s: st.values, sid: st.sid, path, state, tokens, window: context.window }
}

// After a compaction: archive the handoff and queue it for the next prompt. Idempotent.
async function afterCompaction($: $, s: Settings, root: string, sid: string): Promise<void> {
  mem.offer = undefined
  const path = handoffFile(root, s, sid)
  const text = await readText($, path)
  if (handoffState(text) !== 'complete' || text === undefined) return
  const archived = joinPath(handoffDir(root, s), archiveName(sid, new Date(await $.clock.now())))
  await $.fs.write(archived, text)
  await $.fs.write(path, '')
  await $.store.set(restoreKey(sid), restoreNote(archived, text))
}

// Compacts now (between turns). Our own session.compact hook may be skipped for our own call.
async function compactNow($: $, options: Opts): Promise<boolean> {
  const { s, st, sid, path } = await snapshot($, options)
  mem.isCompactScheduled = true
  try {
    const outcome = await $.session.compact({
      instructions: `A detailed handoff (${path}) is given back to the conversation right after this compaction.`,
    })
    if (outcome.skip !== undefined) return false
    mem.isJustCompacted = true
    await afterCompaction($, s, st.root, sid)
    return true
  } finally {
    mem.isCompactScheduled = false
    $.ui.invalidate('ui.render')
  }
}

// Clears the session. When the engine won't run /clear for us, leaves it in the prompt box.
async function clearSession($: $): Promise<void> {
  try {
    await $.command.run({ command: 'clear' })
  } catch {
    await $.prompt.fill({ text: '/clear' })
    $.ui.toast('Press Enter to clear the session.', { timeoutMs: 10_000 })
  }
}

async function submitContinue($: $): Promise<void> {
  const text = mem.pendingContinue
  if (!text) return
  mem.pendingContinue = undefined
  await $.prompt.submit({ text, asUser: true })
}

// Runs a picked option that needs the session idle.
async function runIdle($: $, options: Opts, action: ActionId): Promise<void> {
  const { s, state, path, st } = await snapshot($, options)
  if ((action === 'compact_now' || action === 'continue_fresh') && state !== 'complete') {
    mem.afterHandoff = action
    await ensureHandoffDir($, handoffDir(st.root, s))
    await $.prompt.submit({ text: PREP_PROMPT, asUser: true })
    return
  }
  mem.offer = undefined
  if (action === 'compact_now') {
    await compactNow($, options)
  } else if (action === 'fresh_session') {
    if (state === 'complete') mem.pendingStartup = startupNote(path, 'just now')
    await clearSession($)
  } else if (action === 'continue_fresh') {
    mem.pendingContinue = continuePrompt(path)
    await clearSession($)
    // session.end (reason "clear") usually sends it first; this covers a /clear that raised no session.end.
    $.clock.after(500, () => {
      void submitContinue($).catch(err => $.ui.log(`continue: ${String(err)}`))
    })
  }
  $.ui.invalidate('ui.render')
}

/** Runs a picked option now, or when the running turn ends. Returns what happens, for the model or a toast. */
async function runAction($: $, options: Opts, action: ActionId, via: 'button' | 'tool' | 'command'): Promise<string> {
  const offer = mem.offer
  const { s, sid, st } = await snapshot($, options)
  const resume = via === 'button' && offer?.kind === 'preflight'
  switch (action) {
    case 'auto': {
      mem.offer = undefined
      if (resume) await $.prompt.submit({ text: GO_PROMPT, asUser: true })
      $.ui.invalidate('ui.render')
      return offer?.kind === 'preflight'
        ? `Going ahead. The context manager compacts at ${formatK(s.compact_at)} if needed. Start the tasks.`
        : `Carrying on. The context manager compacts automatically at ${formatK(s.compact_at)}.`
    }
    case 'expand': {
      const target = offer?.expandTo
      if (target === undefined) return 'There is no estimate to size the expansion; offer the options again with estimate_tokens.'
      const current = (await $.store.get(sessionKey(sid))) as Record<string, unknown> | undefined
      await $.store.set(sessionKey(sid), { ...(current ?? {}), ...expandedSettings(target, s) })
      mem.offer = undefined
      if (resume) await $.prompt.submit({ text: GO_PROMPT, asUser: true })
      $.ui.invalidate('ui.render')
      return `This session's compaction threshold is now ${formatK(target)} (this session only). Go ahead with the tasks.`
    }
    case 'snooze': {
      const project = parseJsonFile((await readText($, st.projectPath)) ?? '', 'project').value
      const base = project && typeof project === 'object' && !Array.isArray(project) ? (project as Record<string, unknown>) : {}
      await $.fs.write(st.projectPath, JSON.stringify({ ...base, ...snoozed(s) }, null, 2) + '\n')
      mem.offer = undefined
      $.ui.invalidate('ui.render')
      return `This project's thresholds are now: handoff at ${formatK(s.prep_at + 100_000)}, compaction at ${formatK(s.compact_at + 100_000)}.`
    }
    case 'review': {
      mem.offer = undefined
      if (via === 'tool') return 'Summarise the handoff for the user (goal, status, next steps) and ask what to change.'
      await $.prompt.submit({ text: REVIEW_PROMPT, asUser: true })
      return 'Claude will summarise the handoff.'
    }
    case 'finish_step': {
      mem.offer = undefined
      mem.compactAfterFinish = true
      if (via === 'tool') {
        mem.isFinishTurn = true
        return 'Finish the current step, update the handoff (keep its last line), then end your turn. The context manager compacts afterwards.'
      }
      await $.prompt.submit({ text: FINISH_PROMPT, asUser: true })
      return 'Claude will finish the current step, then the session is compacted.'
    }
    case 'compact_now':
    case 'fresh_session':
    case 'continue_fresh': {
      // From Claude's tool the turn is always running, and a plugin can't clear or prompt from inside it.
      if (mem.isTurnRunning || via === 'tool') {
        mem.pendingAction = action
        $.ui.invalidate('ui.render')
        return via === 'tool'
          ? `${actionLabel(action, offer, s)}: this runs as soon as the current turn ends. End your turn now with one short line.`
          : `${actionLabel(action, offer, s)}: queued; it runs when Claude finishes the current turn.`
      }
      await runIdle($, options, action)
      return `${actionLabel(action, offer, s)}: done.`
    }
  }
}

async function offerOptions(
  $: $,
  options: Opts,
  args: { kind: OfferKind; situation: unknown; recommended?: unknown; reason?: unknown; estimate?: unknown },
): Promise<string> {
  const { s, tokens, window, state } = await snapshot($, options)
  if (!s.enabled) return 'The context manager is turned off here; carry on.'
  if (!s.offer_options) return 'The user has turned the options picker off; carry on with the default behaviour.'
  if (args.kind === 'handoff' && state !== 'complete') {
    return 'The handoff is not complete yet. Finish writing it (ending with the marker line), then offer the options.'
  }
  const situation = isSituation(args.situation) ? args.situation : args.kind === 'preflight' ? 'preflight_overflow' : 'mid_task'
  const estimate = typeof args.estimate === 'number' && args.estimate > 0 ? Math.round(args.estimate) : undefined
  const offer = buildOffer({
    kind: args.kind,
    situation,
    recommended: isActionId(args.recommended) ? args.recommended : undefined,
    reason: typeof args.reason === 'string' ? args.reason : undefined,
    estimate,
    tokens,
    window,
    s,
    now: await $.clock.now(),
  })
  mem.offer = offer
  $.ui.invalidate('ui.render')
  const surfaces = await $.session.surfaces()
  const hasButtons = surfaces.some(x => x === 'terminal' || x === 'desktop')
  const choices = offerChoicesText(offer, s)
  const wait =
    offer.kind === 'preflight'
      ? 'Do not start the tasks until the user has chosen.'
      : 'Then carry on with what the user asked; if they pick nothing, the default (option 1) applies.'
  if (hasButtons) {
    return (
      `The options are now shown to the user as buttons above the prompt:\n${choices}\n` +
      `Tell the user in one line which option you recommend and why. ${wait} ` +
      `If the user answers in chat instead, call ${mem.toolName ?? TOOL} with action "run" and the option id.`
    )
  }
  return (
    `This surface has no option buttons. Ask the user with AskUserQuestion: a short question about how to handle ` +
    `the context, with these options in this order, the first labelled "(Recommended)":\n${choices}\n` +
    `Then call ${mem.toolName ?? TOOL} with action "run" and the option id they chose. ${wait}`
  )
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      await $.command.register({
        name: COMMAND,
        description: 'Claude Context Manager Skill: status and settings; "options" shows the picker, "run <option>" runs one',
        argumentHint: '[options | run <option>]',
      })
      const registered = await $.tool.register({
        name: TOOL,
        description:
          'Claude Context Manager Skill. action "offer": show the user context-management options, after writing a ' +
          'compaction handoff (kind "handoff") or before planned work that may not fit before compaction (kind ' +
          '"preflight", with estimate_tokens). action "run": run the option the user chose.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['offer', 'run'] },
            kind: { type: 'string', enum: ['handoff', 'preflight'] },
            situation: {
              type: 'string',
              enum: ['mid_task', 'near_done', 'delicate_step', 'topic_switch', 'preflight_overflow'],
              description: 'mid_task: work continues; near_done: almost finished; delicate_step: in the middle of a risky step; topic_switch: the user is moving to something else; preflight_overflow: planned work will not fit',
            },
            recommended: {
              type: 'string',
              enum: ['auto', 'compact_now', 'finish_step', 'fresh_session', 'continue_fresh', 'expand', 'review', 'snooze'],
            },
            reason: { type: 'string', description: 'One short sentence shown to the user.' },
            estimate_tokens: { type: 'number', description: 'preflight: tokens of context the planned work will add' },
            option: { type: 'string', description: 'run: the option id the user chose' },
          },
          required: ['action'],
        },
      })
      mem.toolName = registered.tool
      const st = await load($, options)
      const s = st.values
      if (s.enabled && s.offer_on_startup) {
        const dir = handoffDir(st.root, s)
        if (await $.fs.exists(dir)) {
          const now = await $.clock.now()
          const newest = (await $.fs.list(dir))
            .filter(f => f.kind === 'file' && f.size > 0 && /^handoff-.+\.md$/.test(f.name) && !f.name.startsWith(`handoff-${st.sid}`))
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

  // A /clear: the session the picker cleared starts with its continuation prompt.
  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if (e.reason === 'clear' && mem.pendingContinue) {
      $.clock.after(300, () => {
        void submitContinue($).catch(() => undefined)
      })
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
            if (s.offer_options && mem.toolName) {
              extra.push(
                `Once the handoff is saved, call ${mem.toolName} with action "offer", kind "handoff", the situation ` +
                  `that fits the work and a one-sentence reason, so the user can pick how to continue.`,
              )
            }
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

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      mem.isTurnRunning = true
      mem.turnId = e.turnId
      if (e.text === FINISH_PROMPT) mem.isFinishTurn = true
    }
    return next(e)
  })

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
    mem.isTurnRunning = false
    mem.isJustCompacted = false
    const wasFinishTurn = mem.isFinishTurn
    mem.isFinishTurn = false
    $.ui.invalidate('ui.render')
    if (e.isAborted || mem.isCompactScheduled) return result
    try {
      const { s, state, tokens } = await snapshot($, options)
      if (!s.enabled) return result

      // 1. An option picked while the turn ran, or one waiting for the handoff Claude just wrote.
      let action = mem.pendingAction
      mem.pendingAction = undefined
      if (!action && mem.afterHandoff && state === 'complete') {
        action = mem.afterHandoff
        mem.afterHandoff = undefined
      }
      if (!action && mem.compactAfterFinish && wasFinishTurn && state === 'complete') {
        mem.compactAfterFinish = false
        action = 'compact_now'
      }
      if (action) {
        const picked = action
        mem.isCompactScheduled = picked === 'compact_now'
        $.clock.after(800, () => {
          void runIdle($, options, picked)
            .catch(err => $.ui.log(`run ${picked}: ${String(err)}`))
            .finally(() => {
              if (picked === 'compact_now') mem.isCompactScheduled = false
            })
        })
        return result
      }

      // 2. The threshold: compact on our own once the handoff is saved.
      if (s.auto_compact && tokens !== undefined && tokens >= s.compact_at && state === 'complete') {
        mem.isCompactScheduled = true
        $.clock.after(1500, () => {
          void compactNow($, options).catch(() => {
            mem.isCompactScheduled = false // a turn started first; try again after the next one
          })
        })
      }
    } catch (err) {
      $.ui.log(`turn.complete: ${String(err)}`)
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    // Our own tool.
    if (mem.toolName !== undefined && e.tool === mem.toolName) {
      const input = e as unknown as Record<string, unknown>
      try {
        if (input.action === 'run') {
          const option = input.option
          if (!isActionId(option)) return { result: `Unknown option ${JSON.stringify(option)}.` }
          return { result: await runAction($, options, option, 'tool') }
        }
        const kind: OfferKind = input.kind === 'preflight' ? 'preflight' : 'handoff'
        return {
          result: await offerOptions($, options, {
            kind,
            situation: input.situation,
            recommended: input.recommended,
            reason: input.reason,
            estimate: input.estimate_tokens,
          }),
        }
      } catch (err) {
        return { result: `The context manager could not do that: ${String(err)}` }
      }
    }

    const result = await next(e)
    // A task list or an approved plan: give Claude the context budget once per turn.
    if (!PLANNING_TOOLS.has(String(e.tool)) || e.agentId !== undefined || result.deny !== undefined || result.isError) return result
    try {
      if (!mem.toolName || mem.preflightTurnId === mem.turnId) return result
      const { s, tokens } = await snapshot($, options)
      if (!s.enabled || !s.preflight_check || !s.offer_options || tokens === undefined) return result
      mem.preflightTurnId = mem.turnId
      return { ...result, context: [...(result.context ?? []), preflightNote(tokens, s, mem.toolName)] }
    } catch {
      return result
    }
  }).catch(($, e, next) => next(e)) // never block a tool call by failing

  on('command.run', { command: COMMAND }, async ($, e) => {
    try {
      const args = e.args.trim().split(/\s+/).filter(Boolean)
      if (args[0] === 'options') {
        const text = await offerOptions($, options, { kind: 'handoff', situation: 'mid_task' }).catch(() => '')
        const offer = mem.offer
        if (!offer) return { text: text || 'No options to show right now.' }
        const { s } = await snapshot($, options)
        return { text: `Options (buttons above the prompt, or /context-manager run <option>):\n${offerChoicesText(offer, s)}` }
      }
      if (args[0] === 'run') {
        const option = args[1]
        if (!isActionId(option)) return { text: `Unknown option. Use one of: ${Object.keys(ACTION_HELP).join(', ')}` }
        return { text: await runAction($, options, option, 'command') }
      }

      const { st, s, path, state, tokens, window } = await snapshot($, options)
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
      const nextLine =
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
        `  Next      ${nextLine}`,
        `  Handoff   ${handoffLine}`,
        ...(mem.offer ? [`  Options   waiting for your pick: ${mem.offer.actions.map(a => actionLabel(a, mem.offer, s)).join(' | ')}`] : []),
        ...(mem.pendingAction ? [`  Queued    ${actionLabel(mem.pendingAction, mem.offer, s)} (after this turn)`] : []),
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
  }).catch(() => ({ text: 'Claude Context Manager Skill: the command failed.' }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    let view: { text: string; color?: 'warning' | 'success'; offer?: Offer; s: Settings }
    try {
      const { s, state, tokens, window } = await snapshot($, options)
      if (!s.enabled) return next(e)
      const offer = s.offer_options ? mem.offer : undefined
      if (!s.show_meter && !offer) return next(e)
      const phase = phaseOf(tokens, state, s)
      view = {
        text: meterText(tokens, window, phase, s),
        color: phase === 'handoff-due' ? 'warning' : phase === 'ready-to-compact' ? 'success' : undefined,
        offer,
        s,
      }
    } catch {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    const meter = view.color ? <Text color={view.color}>{view.text}</Text> : <Text dimColor>{view.text}</Text>
    const offer = view.offer
    if (!offer) return meter
    const s = view.s
    return (
      <Box flexDirection="column">
        {meter}
        <Text>{offer.reason} How do you want to continue?</Text>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {offer.actions.map((a, i) => (
            <Button
              key={`opt-${a}`}
              label={`${actionLabel(a, offer, s)}${i === 0 ? ' (recommended)' : ''}`}
              hotkey={String(i + 1)}
              variant={i === 0 ? 'primary' : 'secondary'}
              onPress={() => runAction($, options, a, 'button').then(msg => $.ui.toast(msg))}
            />
          ))}
          <Button
            key="dismiss"
            label="Dismiss"
            hotkey="0"
            onPress={() => {
              mem.offer = undefined
              $.ui.invalidate('ui.render')
            }}
          />
        </Box>
      </Box>
    )
  })
}
