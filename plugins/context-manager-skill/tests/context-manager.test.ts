import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { MARKER } from '../hooks/core'

const ROOT = '/work/proj'
const HOME = '/home/craig'
const SID = 'sess-1'
const HANDOFF = `${ROOT}/.claude/context-manager/handoffs/handoff-${SID}.md`
const DONE = `# Compaction handoff\n## Goal\nShip it\n${MARKER}\n`

type World = {
  clock: ReturnType<typeof mock.clock>
  files: Map<string, string>
  tokens: { value: number | undefined }
  compactions: string[]
  seen: { context: string[] }
  toasts: string[]
  filled: string[]
  commands: string[]
  prompts: string[]
}

/** The engine beneath the plugin: an in-memory project, a context size the test sets, and core's compaction. */
function world(on: On, opts: { tokens?: number; files?: Record<string, string>; surfaces?: readonly ('terminal' | 'desktop' | 'vscode' | 'mobile')[] } = {}): World {
  const files = new Map(Object.entries(opts.files ?? {}))
  const tokens = { value: opts.tokens }
  const compactions: string[] = []
  const seen = { context: [] as string[] }
  const toasts: string[] = []
  const filled: string[] = []
  const commands: string[] = []
  const prompts: string[] = []
  mock.store(on)
  mock.env(on, { HOME })
  const clock = mock.clock(on, { now: Date.parse('2026-10-19T14:00:00Z') })
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.id', () => ({ value: SID }))
  on('session.version', () => ({ value: { version: '2.1.303', base: '2.1.303', builtAt: '2026-10-15T00:00:00Z' } }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: tokens.value, window: 1_000_000, percent: tokens.value === undefined ? undefined : Math.round(tokens.value / 10_000) },
      rateLimits: [],
    },
  }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || [...files.keys()].some(k => k.startsWith(`${e.path}/`)) }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', ($, e) => ({
    value: [...files.entries()]
      .filter(([k]) => k.startsWith(`${e.path}/`) && !k.slice(e.path.length + 1).includes('/'))
      .map(([k, v]) => ({ name: k.slice(e.path.length + 1), kind: 'file' as const, size: v.length, mtimeMs: Date.parse('2026-10-18T10:00:00Z'), isLink: false })),
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.surfaces', () => ({ value: opts.surfaces ?? (['terminal'] as const) }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__context-manager-skill__${e.name}` } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('command.run', { command: 'clear' }, () => {
    commands.push('clear')
    return { text: '' }
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('session.compact', ($, e) => {
    compactions.push(e.trigger)
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: tokens.value, tokensAfter: 20_000 }
  })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    seen.context = [...(e.context ?? [])]
    return { text: e.text, context: e.context }
  })
  return { files, tokens, compactions, seen, toasts, clock, filled, commands, prompts }
}

/** Submits a prompt as the person would and returns the context blocks the model was given. */
async function submit($: Engine, w: World, text = 'carry on'): Promise<string[]> {
  w.seen.context = []
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
  return w.seen.context
}

describe('prompt.submit', () => {
  test('stays quiet below the preparation threshold', async ($, on) => {
    const w = world(on, { tokens: 90_000 })
    expect(await submit($, w)).toEqual([])
  })

  test('asks for a handoff past prep_at and creates a git-ignored handoff folder', async ($, on) => {
    const w = world(on, { tokens: 140_000 })
    const context = await submit($, w)
    expect(context.length).toBe(1)
    expect(context[0]).toContain('140k tokens')
    expect(context[0]).toContain(HANDOFF)
    expect(context[0]).toContain('context-manager-skill:prep-compact')
    expect(w.files.get(`${ROOT}/.claude/context-manager/handoffs/.gitignore`)).toBe('*\n')
  })

  test('a project file overrides the user file, which overrides the defaults', async ($, on) => {
    const w = world(on, {
      tokens: 160_000,
      files: {
        [`${HOME}/.claude/context-manager.json`]: '{ "prep_at": "200k", "compact_at": "250k" }',
        [`${ROOT}/.claude/context-manager.json`]: '{ "prep_at": "150k" }',
      },
    })
    const context = await submit($, w)
    expect(context[0]).toContain('150k preparation threshold')
    expect(context[0]).toContain('compaction at 250k')
  })

  test('does nothing when a project turns it off', async ($, on) => {
    const w = world(on, { tokens: 400_000, files: { [`${ROOT}/.claude/context-manager.json`]: '{ "enabled": false }' } })
    expect(await submit($, w)).toEqual([])
  })

  test('plugin options apply when no settings file says otherwise', { options: { prep_at: 300_000 } }, async ($, on) => {
    const w = world(on, { tokens: 200_000 })
    expect(await submit($, w)).toEqual([])
  })

  test('a broken settings file is ignored rather than breaking the session', async ($, on) => {
    const w = world(on, { tokens: 140_000, files: { [`${ROOT}/.claude/context-manager.json`]: '{ nope' } })
    expect((await submit($, w))[0]).toContain('130k preparation threshold')
  })
})

describe('session.compact gate', () => {
  const compact = ($: { session: { compact: (e: never) => Promise<unknown> } }, trigger: string) =>
    $.session.compact({ trigger, messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never) as Promise<{ skip?: string; messages?: unknown[] }>

  test('holds auto-compaction below compact_at', async ($, on) => {
    const w = world(on, { tokens: 140_000, files: { [HANDOFF]: DONE } })
    const r = await compact($, 'auto')
    expect(r.skip).toContain('150k')
    expect(w.compactions).toEqual([])
  })

  test('holds auto-compaction until the handoff is complete', async ($, on) => {
    const w = world(on, { tokens: 160_000, files: { [HANDOFF]: '# half written' } })
    expect((await compact($, 'auto')).skip).toContain('handoff')
    expect(w.compactions).toEqual([])
  })

  test('lets it run past the safety limit even without a handoff', async ($, on) => {
    const w = world(on, { tokens: 320_000 })
    expect((await compact($, 'auto')).skip).toBeUndefined()
    expect(w.compactions).toEqual(['auto'])
  })

  test('with a complete handoff: compacts, archives it, and restores it on the next prompt', async ($, on) => {
    const w = world(on, { tokens: 160_000, files: { [HANDOFF]: DONE } })
    expect((await compact($, 'auto')).skip).toBeUndefined()
    expect(w.compactions).toEqual(['auto'])
    expect(w.files.get(HANDOFF)).toBe('')
    const archived = [...w.files.keys()].find(k => k.includes('.used-'))
    expect(archived).toBeDefined()
    expect(w.files.get(archived ?? '')).toBe(DONE)
    w.tokens.value = 25_000
    const context = await submit($, w)
    expect(context[0]).toContain('This session was just compacted')
    expect(context[0]).toContain('Ship it')
    expect(await submit($, w)).toEqual([]) // restored once only
  })

  test('a manual /compact without a handoff is blocked once, then allowed', async ($, on) => {
    const w = world(on, { tokens: 100_000 })
    expect((await compact($, 'manual')).skip).toContain('/compact again')
    expect((await compact($, 'manual')).skip).toBeUndefined()
    expect(w.compactions).toEqual(['manual'])
  })

  test('a precompute is allowed only once the handoff is ready', async ($, on) => {
    const w = world(on, { tokens: 160_000 })
    expect((await compact($, 'precompute')).skip).toBeDefined()
    w.files.set(HANDOFF, DONE)
    expect((await compact($, 'precompute')).skip).toBeUndefined()
    expect(w.files.get(HANDOFF)).toBe(DONE) // a precompute installs nothing, so nothing is archived
  })
})

describe('compacting on its own', () => {
  const turnEnds = ($: Engine) =>
    $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'completed' } as never)

  test('compacts after the turn once the handoff is saved and compact_at is reached', async ($, on) => {
    const w = world(on, { tokens: 160_000, files: { [HANDOFF]: DONE } })
    await turnEnds($)
    expect(w.compactions).toEqual([])
    await w.clock.advance(2000)
    expect(w.compactions).toHaveLength(1)
    expect(w.files.get(HANDOFF)).toBe('')
    w.tokens.value = 25_000
    expect((await submit($, w))[0]).toContain('Ship it')
  })

  test('waits while the handoff is missing', async ($, on) => {
    const w = world(on, { tokens: 160_000 })
    await turnEnds($)
    await w.clock.advance(2000)
    expect(w.compactions).toEqual([])
  })

  test('leaves it to you when auto_compact is off', { options: { auto_compact: false } }, async ($, on) => {
    const w = world(on, { tokens: 160_000, files: { [HANDOFF]: DONE } })
    await turnEnds($)
    await w.clock.advance(2000)
    expect(w.compactions).toEqual([])
  })
})

describe('/context-manager', () => {
  test('reports status, settings and where each comes from', async ($, on) => {
    const w = world(on, { tokens: 142_000, files: { [`${ROOT}/.claude/context-manager.json`]: '{ "compact_at": "250k" }' } })
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    const out = await $.command.run({
      command: 'context-manager',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    } as never)
    const text = (out as { text?: string }).text ?? ''
    expect(text).toContain('active in this session')
    expect(text).toContain('142k of 1M')
    expect(text).toContain('handoff due')
    expect(text).toMatch(/compact_at\s+250k\s+project file/)
    expect(text).toMatch(/prep_at\s+130k\s+default/)
  })
})

describe('new sessions', () => {
  test('point the first prompt at the latest handoff from an earlier session', async ($, on) => {
    const w = world(on, { tokens: 5_000, files: { [`${ROOT}/.claude/context-manager/handoffs/handoff-old.used-20261018-100000.md`]: DONE } })
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    const first = await submit($, w, 'hi')
    expect(first[0]).toContain('handoff-old.used-20261018-100000.md')
    expect(await submit($, w, 'and again')).toEqual([])
  })
})

describe('context meter', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`draws above the prompt on ${surface}`, async ($, on) => {
      const w = world(on, { tokens: 142_000 })
      const ui = await $.ui.mount({
        plugin: 'context-manager-skill',
        surface,
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 10 },
      } as never)
      expect(await ui.find({ type: 'Text', text: /Context 142k \/ 1M \(14%\) · handoff due now/ })).toBeDefined()
      await ui.unmount()
    })
  }

  test('can be switched off', { options: { show_meter: false } }, async ($, on) => {
    const w = world(on, { tokens: 142_000 })
    const ui = await $.ui.mount({
      plugin: 'context-manager-skill',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10 },
    } as never)
    expect(await ui.find({ type: 'Text', text: /Context/ })).toBeUndefined()
    await ui.unmount()
  })
})

// ---------- v2.1: options picker, pre-flight check, actions ----------

const TOOL = 'mcp__context-manager-skill__context_manager'

async function startSession($: Engine): Promise<void> {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
}

async function callTool($: Engine, input: Record<string, unknown>): Promise<string> {
  const r = (await $.tool.call({ tool: TOOL, tool_use_id: `tu-${Math.random()}`, ...input } as never)) as { result?: unknown }
  return String(r.result)
}

async function startTurn($: Engine, text = 'do the work'): Promise<void> {
  await $.turn.start({ text, turnId: 't-run' } as never)
}

async function endTurn($: Engine): Promise<void> {
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't-run', reason: 'completed' } as never)
}

describe('pre-flight check', () => {
  test('adds the context budget when Claude creates a task list, once per turn', async ($, on) => {
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'x' } } } as never))
    world(on, { tokens: 120_000 })
    await startSession($)
    await startTurn($)
    const first = (await $.tool.call({ tool: 'TaskCreate', tool_use_id: 'a', subject: 'x', description: 'y' } as never)) as { context?: string[] }
    expect(first.context?.[0]).toContain('30k of room')
    expect(first.context?.[0]).toContain(TOOL)
    const second = (await $.tool.call({ tool: 'TaskCreate', tool_use_id: 'b', subject: 'x', description: 'y' } as never)) as { context?: string[] }
    expect(second.context).toBeUndefined()
  })

  test('can be switched off', { options: { preflight_check: false } }, async ($, on) => {
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'x' } } } as never))
    world(on, { tokens: 120_000 })
    await startSession($)
    await startTurn($)
    const r = (await $.tool.call({ tool: 'TaskCreate', tool_use_id: 'a', subject: 'x', description: 'y' } as never)) as { context?: string[] }
    expect(r.context).toBeUndefined()
  })

  test('an overflow offer recommends raising the limit when the work fits the window', async ($, on) => {
    world(on, { tokens: 120_000 })
    await startSession($)
    const text = await callTool($, { action: 'offer', kind: 'preflight', situation: 'preflight_overflow', estimate_tokens: 200_000, reason: 'Six files to refactor.' })
    expect(text).toContain('buttons above the prompt')
    expect(text).toMatch(/1\. Raise this session's limit to 350k \(recommended\)/)
    expect(text).toContain('Do not start the tasks')
  })

  test('recommends continuing in a fresh session when the work cannot fit', async ($, on) => {
    world(on, { tokens: 120_000 })
    await startSession($)
    const text = await callTool($, { action: 'offer', kind: 'preflight', situation: 'preflight_overflow', estimate_tokens: 900_000 })
    expect(text).not.toContain('Raise this session')
    expect(text).toMatch(/1\. Continue in a fresh session \(recommended\)/)
  })

  test('raising the limit applies to this session only', async ($, on) => {
    const w = world(on, { tokens: 120_000 })
    await startSession($)
    await callTool($, { action: 'offer', kind: 'preflight', situation: 'preflight_overflow', estimate_tokens: 200_000 })
    expect(await callTool($, { action: 'run', option: 'expand' })).toContain('now 350k')
    const out = await $.command.run({ command: 'context-manager', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
    expect((out as { text?: string }).text).toMatch(/compact_at\s+350k\s+this session/)
    expect(w.files.get(`${ROOT}/.claude/context-manager.json`)).toBeUndefined() // the project is untouched
  })
})

describe('options picker', () => {
  test('VS Code gets an AskUserQuestion instruction instead of buttons', async ($, on) => {
    world(on, { tokens: 140_000, files: { [HANDOFF]: DONE }, surfaces: ['vscode'] })
    await startSession($)
    const text = await callTool($, { action: 'offer', kind: 'handoff', situation: 'near_done' })
    expect(text).toContain('AskUserQuestion')
    expect(text).toMatch(/1\. Start a fresh session \(recommended\)/)
  })

  test('a handoff offer waits until the handoff is complete', async ($, on) => {
    world(on, { tokens: 140_000, files: { [HANDOFF]: '# half' } })
    await startSession($)
    expect(await callTool($, { action: 'offer', kind: 'handoff', situation: 'mid_task' })).toContain('not complete')
  })

  test('the prep note asks Claude to offer options once the handoff is saved', async ($, on) => {
    const w = world(on, { tokens: 140_000 })
    await startSession($)
    const context = await submit($, w)
    expect(context.some(c => c.includes('action "offer", kind "handoff"'))).toBe(true)
  })

  test('draws the options as buttons, recommended first, and runs the one pressed', async ($, on) => {
    const w = world(on, { tokens: 140_000, files: { [HANDOFF]: DONE } })
    await startSession($)
    await callTool($, { action: 'offer', kind: 'handoff', situation: 'delicate_step', reason: 'Mid-migration.' })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'context-manager-skill', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10 } } as never)
      expect(await ui.find({ key: 'opt-finish_step' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Mid-migration/ })).toBeDefined()
      if (surface === 'desktop') {
        await ui.press({ key: 'opt-snooze' })
        expect(w.files.get(`${ROOT}/.claude/context-manager.json`)).toContain('"compact_at": 250000')
      }
      await ui.unmount()
    }
  })
})

describe('actions', () => {
  test('compact now, picked mid-turn, runs when the turn ends', async ($, on) => {
    const w = world(on, { tokens: 140_000, files: { [HANDOFF]: DONE } })
    await startSession($)
    await startTurn($)
    await callTool($, { action: 'offer', kind: 'handoff', situation: 'mid_task' })
    expect(await callTool($, { action: 'run', option: 'compact_now' })).toContain('End your turn')
    expect(w.compactions).toEqual([])
    await endTurn($)
    await w.clock.advance(1000)
    expect(w.compactions).toHaveLength(1)
    expect(w.files.get(HANDOFF)).toBe('')
  })

  test('continue in a fresh session: clears, then asks the new session to continue from the handoff', async ($, on) => {
    const w = world(on, { tokens: 140_000, files: { [HANDOFF]: DONE } })
    await startSession($)
    await startTurn($)
    await callTool($, { action: 'offer', kind: 'preflight', situation: 'preflight_overflow', estimate_tokens: 900_000 })
    expect(await callTool($, { action: 'run', option: 'continue_fresh' })).toContain('End your turn')
    expect(w.commands).toEqual([])
    await endTurn($)
    await w.clock.advance(2000)
    expect(w.commands).toEqual(['clear'])
    expect(w.prompts.some(p => p.includes(`read the handoff at ${HANDOFF}`))).toBe(true)
  })

  test('continue in a fresh session without a handoff asks for one first', async ($, on) => {
    const w = world(on, { tokens: 120_000 })
    await startSession($)
    await startTurn($)
    await callTool($, { action: 'offer', kind: 'preflight', situation: 'preflight_overflow', estimate_tokens: 900_000 })
    await callTool($, { action: 'run', option: 'continue_fresh' })
    await endTurn($)
    await w.clock.advance(1000)
    expect(w.prompts.some(p => p.includes('prep-compact'))).toBe(true)
    expect(w.commands).toEqual([])
    // Claude writes the handoff during that turn; when it ends, the plugin clears and continues.
    await startTurn($, 'save the handoff')
    w.files.set(HANDOFF, DONE)
    await endTurn($)
    await w.clock.advance(2000)
    expect(w.commands).toEqual(['clear'])
    expect(w.prompts.some(p => p.includes('Continue the work from the previous session'))).toBe(true)
  })

  test('finish this step: Claude finishes, then the plugin compacts', async ($, on) => {
    const w = world(on, { tokens: 140_000, files: { [HANDOFF]: DONE } })
    await startSession($)
    await startTurn($)
    await callTool($, { action: 'offer', kind: 'handoff', situation: 'delicate_step' })
    expect(await callTool($, { action: 'run', option: 'finish_step' })).toContain('Finish the current step')
    await endTurn($)
    await w.clock.advance(1000)
    expect(w.compactions).toHaveLength(1)
  })

  test('/context-manager run works where there are no buttons', async ($, on) => {
    const w = world(on, { tokens: 140_000, files: { [HANDOFF]: DONE } })
    await startSession($)
    const out = await $.command.run({ command: 'context-manager', args: 'run snooze', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
    expect((out as { text?: string }).text).toContain('compaction at 250k')
    expect(w.files.get(`${ROOT}/.claude/context-manager.json`)).toContain('"prep_at": 230000')
  })
})
