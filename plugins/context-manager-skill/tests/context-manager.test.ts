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
}

/** The engine beneath the plugin: an in-memory project, a context size the test sets, and core's compaction. */
function world(on: On, opts: { tokens?: number; files?: Record<string, string> } = {}): World {
  const files = new Map(Object.entries(opts.files ?? {}))
  const tokens = { value: opts.tokens }
  const compactions: string[] = []
  const seen = { context: [] as string[] }
  const toasts: string[] = []
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
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('session.compact', ($, e) => {
    compactions.push(e.trigger)
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: tokens.value, tokensAfter: 20_000 }
  })
  on('prompt.submit', ($, e) => {
    seen.context = [...(e.context ?? [])]
    return { text: e.text, context: e.context }
  })
  return { files, tokens, compactions, seen, toasts, clock }
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
    on('turn.complete', ($, e) => ({ text: e.answer }))
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
    on('turn.complete', ($, e) => ({ text: e.answer }))
    const w = world(on, { tokens: 160_000 })
    await turnEnds($)
    await w.clock.advance(2000)
    expect(w.compactions).toEqual([])
  })

  test('leaves it to you when auto_compact is off', { options: { auto_compact: false } }, async ($, on) => {
    on('turn.complete', ($, e) => ({ text: e.answer }))
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
